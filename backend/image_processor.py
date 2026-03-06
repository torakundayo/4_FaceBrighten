"""
画像処理コアロジック

既存の face_segmentation.py から移植。
処理ロジック自体は変更なし。I/Oのみ変更（ローカルファイル → メモリ上のバイト列）。
"""

import base64
import io

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor


# === モデル管理 ===


def load_face_parser(model_name="jonathandinu/face-parsing"):
    """SegFormer顔パーシングモデルの読み込み"""
    processor = SegformerImageProcessor.from_pretrained(model_name)
    model = SegformerForSemanticSegmentation.from_pretrained(model_name)
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(device)
    return processor, model, device


# === セグメンテーション ===


def segment_face(pil_image, processor, model, device):
    """SegFormerによる顔セグメンテーション"""
    inputs = processor(images=pil_image, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)
    logits = outputs.logits
    upsampled = torch.nn.functional.interpolate(
        logits,
        size=pil_image.size[::-1],
        mode="bilinear",
        align_corners=False,
    )
    probs = torch.softmax(upsampled, dim=1)[0]
    labels = upsampled.argmax(dim=1)[0]
    return labels.cpu().numpy(), probs.cpu().numpy()


# === マスク生成 ===


def create_face_skin_mask(labels, probs):
    """顔の肌領域のマスク生成（カラーグレーディング用）"""
    mask = np.zeros(labels.shape, dtype=np.float32)
    for c in [1]:  # 肌
        mask += probs[c] * 1.0
    for c in [2, 3, 4, 5, 10, 11, 12, 13]:  # 顔パーツ
        mask += probs[c] * 0.9
    for c in [14]:  # 首
        mask += probs[c] * 0.7
    return np.clip(mask, 0, 1)


def create_skin_only_mask(probs):
    """肌のみのマスク（スムージング用: 目・眉・唇を除外）"""
    mask = probs[1].copy()
    return np.clip(mask, 0, 1)


# === 肌スムージング ===


def smooth_skin(img_rgb, skin_mask, strength=0.4):
    """バイラテラルフィルタによる肌スムージング"""
    if skin_mask.max() == 0:
        return img_rgb

    h, w = img_rgb.shape[:2]
    d = max(5, min(15, max(h, w) // 500))
    if d % 2 == 0:
        d += 1
    sigma_color = 40 + 30 * strength
    sigma_space = 40 + 30 * strength

    smoothed = cv2.bilateralFilter(img_rgb, d, sigma_color, sigma_space)

    blend_mask = skin_mask * strength
    blend_mask[blend_mask < 0.05] = 0.0
    blend_mask_3ch = np.stack([blend_mask] * 3, axis=-1)

    result = (
        img_rgb.astype(np.float32) * (1 - blend_mask_3ch)
        + smoothed.astype(np.float32) * blend_mask_3ch
    )
    return np.clip(result, 0, 255).astype(np.uint8)


# === DaVinci Resolve 式カラーグレーディング ===


def apply_lift(l_channel, amount):
    """Lift: シャドウ（暗部）を調整"""
    l_norm = l_channel / 255.0
    influence = (1.0 - l_norm) ** 0.8
    l_new = l_norm + amount * influence
    return np.clip(l_new * 255, 0, 255)


def apply_gamma(l_channel, amount):
    """Gamma: ミッドトーン（中間調）を調整"""
    l_norm = l_channel / 255.0
    influence = 4.0 * l_norm * (1.0 - l_norm)
    l_new = l_norm + amount * influence
    return np.clip(l_new * 255, 0, 255)


def apply_offset(l_channel, amount):
    """Offset: 全トーンを均一に調整"""
    l_norm = l_channel / 255.0
    l_new = l_norm + amount
    return np.clip(l_new * 255, 0, 255)


# === 自動パラメータ算出 ===


def analyze_face_luminance(l_channel, mask):
    """顔領域の輝度統計を分析"""
    face_region = mask > 0.3
    if not face_region.any():
        return None
    face_l = l_channel[face_region]
    return {
        "mean": float(np.mean(face_l)),
        "median": float(np.median(face_l)),
        "p10": float(np.percentile(face_l, 10)),
        "p90": float(np.percentile(face_l, 90)),
        "std": float(np.std(face_l)),
    }


def calculate_target_luminance(stats):
    """画像の輝度状態から目標輝度を算出"""
    current = stats["mean"]
    if current < 40:
        target = min(current * 1.6, current + 40)
    elif current < 70:
        target = min(current * 1.35, current + 25)
    elif current < 100:
        target = min(current * 1.15, current + 15)
    else:
        target = current
    return target


def auto_grade_params(stats, target):
    """目標輝度に到達するためのLift/Gamma/Offset/Satを自動算出"""
    gap = target - stats["mean"]
    if gap <= 0:
        return {"lift": 0, "gamma": 0, "offset": 0, "sat_boost": 0}

    intensity = min(gap / 30.0, 1.0)
    shadow_ratio = max(0, min(1, (70 - stats["mean"]) / 70))
    mid_ratio = 1.0 - shadow_ratio

    lift = intensity * (0.055 + 0.095 * shadow_ratio)
    gamma = intensity * (0.028 + 0.050 * mid_ratio)
    offset = intensity * 0.020

    sat_factor = 1.0 - min(stats["std"] / 30, 0.5)
    sat_boost = intensity * 0.10 * sat_factor

    return {
        "lift": round(lift, 4),
        "gamma": round(gamma, 4),
        "offset": round(offset, 4),
        "sat_boost": round(sat_boost, 4),
    }


# === スキントーンベクトル保持 ===


def preserve_skin_tone_vector(a_orig, b_orig, a_new, b_new, mask):
    """ベクトルスコープのスキントーンライン上に色を維持"""
    skin_region = mask > 0.3
    if not skin_region.any():
        return a_new, b_new

    mean_a = np.mean(a_orig[skin_region]) - 128
    mean_b = np.mean(b_orig[skin_region]) - 128
    skin_angle = np.arctan2(mean_b, mean_a)

    a_delta = (a_new - 128) - (a_orig - 128)
    b_delta = (b_new - 128) - (b_orig - 128)

    cos_skin = np.cos(skin_angle)
    sin_skin = np.sin(skin_angle)
    projection = a_delta * cos_skin + b_delta * sin_skin

    a_corrected = (a_orig - 128) + projection * cos_skin * mask + 128
    b_corrected = (b_orig - 128) + projection * sin_skin * mask + 128

    a_result = a_orig * (1 - mask) + a_corrected * mask
    b_result = b_orig * (1 - mask) + b_corrected * mask

    return (
        np.clip(a_result, 0, 255).astype(np.float32),
        np.clip(b_result, 0, 255).astype(np.float32),
    )


# === メイン処理パイプライン ===


def process_image(pil_image, processor, model, device):
    """
    メインの画像処理パイプライン

    Args:
        pil_image: PIL.Image (RGB)
        processor: SegFormerImageProcessor
        model: SegFormerForSemanticSegmentation
        device: "cuda" or "cpu"

    Returns:
        result_image: PIL.Image (RGB) - 処理済み画像
        stats: dict - 処理統計情報
    """
    orig_size = pil_image.size  # (width, height)

    # --- Step 1: SegFormerセグメンテーション ---
    labels, probs = segment_face(pil_image, processor, model, device)

    total_pixels = labels.size

    # --- Step 2: マスク生成 ---
    raw_mask = create_face_skin_mask(labels, probs)
    skin_only_mask = create_skin_only_mask(probs)

    img_bgr = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l_ch = lab[:, :, 0].astype(np.float32)

    # 暗さの重み付け（暗い部分ほど補正が強くなる）
    darkness_weight = np.clip((1.0 - l_ch / 255.0) ** 1.2, 0, 1)
    final_mask = raw_mask * darkness_weight

    # テール除去
    final_mask[final_mask < 0.08] = 0.0
    soft_ksize = max(orig_size) // 500
    if soft_ksize % 2 == 0:
        soft_ksize += 1
    if soft_ksize >= 3:
        final_mask = cv2.GaussianBlur(final_mask, (soft_ksize, soft_ksize), 0)
    if final_mask.max() > 0:
        final_mask = final_mask / final_mask.max()
    final_mask = final_mask**2.0
    final_mask[final_mask < 0.03] = 0.0

    # 顔が検出されたか判定
    face_pixels = np.sum(final_mask > 0.3)
    if face_pixels < 100:
        return pil_image, {
            "face_detected": False,
            "message": "顔が検出されませんでした",
        }

    # --- Step 3: カラーグレーディング ---
    a_ch = lab[:, :, 1].astype(np.float32)
    b_ch = lab[:, :, 2].astype(np.float32)

    face_stats = analyze_face_luminance(l_ch, final_mask)
    if face_stats:
        target_l = calculate_target_luminance(face_stats)
        params = auto_grade_params(face_stats, target_l)
        LIFT = params["lift"]
        GAMMA = params["gamma"]
        OFFSET = params["offset"]
        SAT_BOOST = params["sat_boost"]
    else:
        LIFT, GAMMA, OFFSET, SAT_BOOST = 0.06, 0.03, 0.01, 0.05
        face_stats = {"mean": 0, "median": 0, "p10": 0, "p90": 0, "std": 0}
        target_l = 0

    # Lift → Gamma → Offset（マスクなしでフル画像に適用）
    l_graded = apply_lift(l_ch, LIFT)
    l_graded = apply_gamma(l_graded, GAMMA)
    l_graded = apply_offset(l_graded, OFFSET)

    # 彩度補正（マスクなしでフル画像に適用）
    sat_factor = 1.0 + SAT_BOOST
    a_graded = 128 + (a_ch - 128) * sat_factor
    b_graded = 128 + (b_ch - 128) * sat_factor

    # --- Step 4: スキントーンベクトル保持 ---
    # マスク=1の全体で補正方向を算出し、後でマスクブレンド
    full_mask = np.ones_like(final_mask)
    a_corrected, b_corrected = preserve_skin_tone_vector(
        a_ch, b_ch, a_graded, b_graded, full_mask
    )

    # LAB → RGB（グレーディング済みフル画像）
    lab_graded = lab.copy()
    lab_graded[:, :, 0] = np.clip(l_graded, 0, 255).astype(np.uint8)
    lab_graded[:, :, 1] = np.clip(a_corrected, 0, 255).astype(np.uint8)
    lab_graded[:, :, 2] = np.clip(b_corrected, 0, 255).astype(np.uint8)
    graded_bgr = cv2.cvtColor(lab_graded, cv2.COLOR_LAB2BGR)
    graded_rgb = cv2.cvtColor(graded_bgr, cv2.COLOR_BGR2RGB)

    # 背景保護: マスクで1回だけブレンド（元画像のピクセルを完全保持）
    orig_rgb = np.array(pil_image)
    mask_3ch = np.stack([final_mask] * 3, axis=-1)
    final_rgb = (
        orig_rgb.astype(np.float32) * (1 - mask_3ch)
        + graded_rgb.astype(np.float32) * mask_3ch
    )
    final_rgb = np.clip(final_rgb, 0, 255).astype(np.uint8)

    # 統計用にマスク適用後の輝度を計算
    l_result = l_ch * (1 - final_mask) + l_graded * final_mask

    # --- Step 5: 肌スムージング ---
    SKIN_SMOOTH = 0.4
    final_rgb = smooth_skin(final_rgb, skin_only_mask, SKIN_SMOOTH)

    result_image = Image.fromarray(final_rgb)

    # マスク画像を生成（可視化用）
    mask_vis = (final_mask * 255).astype(np.uint8)
    mask_pil = Image.fromarray(mask_vis, mode="L")
    # リサイズして転送量を抑える（長辺512px）
    max_dim = max(mask_pil.size)
    if max_dim > 512:
        scale = 512 / max_dim
        mask_pil = mask_pil.resize(
            (int(mask_pil.width * scale), int(mask_pil.height * scale)),
            Image.BILINEAR,
        )
    mask_buffer = io.BytesIO()
    mask_pil.save(mask_buffer, format="PNG")
    mask_b64 = base64.b64encode(mask_buffer.getvalue()).decode("utf-8")

    # 統計情報
    face_region = final_mask > 0.3
    orig_mean = float(l_ch[face_region].mean())
    result_mean = float(l_result[face_region].mean())

    stats = {
        "face_detected": True,
        "face_pixels": int(face_pixels),
        "face_ratio": round(face_pixels / total_pixels * 100, 2),
        "luminance_before": round(orig_mean, 1),
        "luminance_after": round(result_mean, 1),
        "luminance_change": round(result_mean - orig_mean, 1),
        "params": {
            "lift": LIFT,
            "gamma": GAMMA,
            "offset": OFFSET,
            "sat_boost": round(SAT_BOOST * 100, 1),
        },
        "image_size": f"{orig_size[0]}x{orig_size[1]}",
        "mask_image": f"data:image/png;base64,{mask_b64}",
    }

    return result_image, stats
