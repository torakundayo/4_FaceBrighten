"""
HuggingFace SegFormer 顔パーシング + プロ品質カラーグレーディング

DaVinci Resolveのカラーホイール操作を再現:
- Lift: シャドウの微調整
- Gamma: ミッドトーンの微調整
- Offset: 全体の微調整
- スキントーンベクトル保持: ベクトルスコープのI-Line上に維持
"""

import cv2
import numpy as np
import torch
from pathlib import Path
from PIL import Image
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor


def load_face_parser(model_name="jonathandinu/face-parsing"):
    print(f"  モデル読み込み中: {model_name}")
    processor = SegformerImageProcessor.from_pretrained(model_name)
    model = SegformerForSemanticSegmentation.from_pretrained(model_name)
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(device)
    print(f"  デバイス: {device}")
    return processor, model, device


def segment_face(pil_image, processor, model, device):
    inputs = processor(images=pil_image, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)
    logits = outputs.logits
    upsampled = torch.nn.functional.interpolate(
        logits, size=pil_image.size[::-1],
        mode="bilinear", align_corners=False,
    )
    probs = torch.softmax(upsampled, dim=1)[0]
    labels = upsampled.argmax(dim=1)[0]
    return labels.cpu().numpy(), probs.cpu().numpy()


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
    mask = probs[1].copy()  # 肌クラスのみ
    return np.clip(mask, 0, 1)


def smooth_skin(img_rgb, skin_mask, strength=0.5):
    """
    肌スムージング: バイラテラルフィルタで肌のテクスチャを
    自然に滑らかにする。目・眉・唇はマスク外なので影響しない。

    strength: 0.0（効果なし）〜 1.0（最大）
    """
    if skin_mask.max() == 0:
        return img_rgb

    h, w = img_rgb.shape[:2]

    # バイラテラルフィルタのパラメータ
    # d: フィルタ径（画像サイズに応じて調整）
    d = max(5, min(15, max(h, w) // 500))
    if d % 2 == 0:
        d += 1
    sigma_color = 40 + 30 * strength   # 色の類似度
    sigma_space = 40 + 30 * strength   # 空間的な広がり

    # バイラテラルフィルタ適用（エッジを保持しつつ平滑化）
    smoothed = cv2.bilateralFilter(
        img_rgb, d, sigma_color, sigma_space
    )

    # 肌マスクにstrengthを乗算
    blend_mask = skin_mask * strength
    # 微小値カット
    blend_mask[blend_mask < 0.05] = 0.0
    blend_mask_3ch = np.stack([blend_mask] * 3, axis=-1)

    # ブレンド: マスク内だけスムージング適用
    result = (
        img_rgb.astype(np.float32) * (1 - blend_mask_3ch)
        + smoothed.astype(np.float32) * blend_mask_3ch
    )
    return np.clip(result, 0, 255).astype(np.uint8)


# === DaVinci Resolve スタイルのカラーグレーディング ===

def apply_lift(l_channel, amount):
    """
    Liftコントロール: シャドウ（暗部）を調整
    DaVinci ResolveのLiftマスターホイールと同等
    amount: -1.0〜+1.0 (通常 +0.03〜+0.08 程度の微調整)
    暗い部分ほど影響が大きく、明るい部分にはほぼ影響しない
    """
    l_norm = l_channel / 255.0
    # 暗い部分ほど影響大（1-x のカーブ）
    influence = (1.0 - l_norm) ** 0.8
    l_new = l_norm + amount * influence
    return np.clip(l_new * 255, 0, 255)


def apply_gamma(l_channel, amount):
    """
    Gammaコントロール: ミッドトーン（中間調）を調整
    DaVinci ResolveのGammaマスターホイールと同等
    amount: -1.0〜+1.0 (通常 +0.01〜+0.05 程度の微調整)
    中間調に最も影響し、純黒・純白にはほぼ影響しない
    """
    l_norm = l_channel / 255.0
    # ベルカーブ: 中間調に最も影響
    influence = 4.0 * l_norm * (1.0 - l_norm)
    l_new = l_norm + amount * influence
    return np.clip(l_new * 255, 0, 255)


def apply_offset(l_channel, amount):
    """
    Offsetコントロール: 全トーンを均一に調整
    DaVinci ResolveのOffsetと同等
    amount: -1.0〜+1.0 (通常 +0.005〜+0.02 程度の微調整)
    """
    l_norm = l_channel / 255.0
    l_new = l_norm + amount
    return np.clip(l_new * 255, 0, 255)


def analyze_face_luminance(l_channel, mask):
    """顔領域の輝度統計を分析して自動パラメータ算出の基礎データを返す"""
    face_region = mask > 0.3
    if not face_region.any():
        return None
    face_l = l_channel[face_region]
    stats = {
        'mean': float(np.mean(face_l)),
        'median': float(np.median(face_l)),
        'p10': float(np.percentile(face_l, 10)),
        'p90': float(np.percentile(face_l, 90)),
        'std': float(np.std(face_l)),
    }
    return stats


def calculate_target_luminance(stats):
    """画像の輝度状態から目標輝度を算出"""
    current = stats['mean']

    # 目標: 自然な顔の明るさ範囲の下限を目指す
    # 暗い画像ほど大きく補正、明るい画像ほど控えめに
    if current < 40:
        # 非常に暗い: 1.7倍を目標（ただし最大+40）
        target = min(current * 1.7, current + 40)
    elif current < 70:
        # 暗い（逆光）: 1.45倍を目標（ただし最大+30）
        target = min(current * 1.45, current + 30)
    elif current < 100:
        # やや暗い: 控えめな補正
        target = min(current * 1.2, current + 18)
    else:
        # 十分明るい: 補正不要
        target = current

    return target


def auto_grade_params(stats, target):
    """目標輝度に到達するためのLift/Gamma/Offset/Satを自動算出"""
    gap = target - stats['mean']

    if gap <= 0:
        return {'lift': 0, 'gamma': 0, 'offset': 0, 'sat_boost': 0}

    # gap を 0〜30 の範囲で正規化（0〜1）
    intensity = min(gap / 30.0, 1.0)

    # 暗い画像ほどLift（シャドウ）を重視、
    # 明るい画像ほどGamma（ミッドトーン）を重視
    shadow_ratio = max(0, min(1, (70 - stats['mean']) / 70))
    mid_ratio = 1.0 - shadow_ratio

    # Lift: シャドウ持ち上げ（暗い画像で強く効く）
    lift = intensity * (0.055 + 0.095 * shadow_ratio)
    # Gamma: ミッドトーン調整（明るい画像で強く効く）
    gamma = intensity * (0.028 + 0.050 * mid_ratio)
    # Offset: 全体の微調整（常に控えめ）
    offset = intensity * 0.020

    # 彩度: Liftで持ち上げると色が薄く見えるため補正
    # 元の彩度が高い場合は控えめに
    sat_factor = 1.0 - min(stats['std'] / 30, 0.5)
    sat_boost = intensity * 0.10 * sat_factor

    return {
        'lift': round(lift, 4),
        'gamma': round(gamma, 4),
        'offset': round(offset, 4),
        'sat_boost': round(sat_boost, 4),
    }


def preserve_skin_tone_vector(a_orig, b_orig, a_new, b_new, mask):
    """
    ベクトルスコープのスキントーンライン（I-Line）上に色を維持

    スキントーンの方向:
    - ベクトルスコープ上で約123°の方向（I-Line）
    - LAB空間では a>128 (赤方向), b>128 (黄方向) の組み合わせ
    - この方向から逸脱しないよう色を補正
    """
    # マスク領域の元の肌色方向を計算
    skin_region = mask > 0.3
    if not skin_region.any():
        return a_new, b_new

    # 元の平均肌色ベクトル（128が中心）
    mean_a = np.mean(a_orig[skin_region]) - 128
    mean_b = np.mean(b_orig[skin_region]) - 128

    # 肌色の方向（角度）
    skin_angle = np.arctan2(mean_b, mean_a)
    print(f"  スキントーン角度: {np.degrees(skin_angle):.1f}°")

    # 補正後の色が肌色方向からずれた分を修正
    a_delta = (a_new - 128) - (a_orig - 128)
    b_delta = (b_new - 128) - (b_orig - 128)

    # デルタをスキントーン方向に投影（方向を維持）
    cos_skin = np.cos(skin_angle)
    sin_skin = np.sin(skin_angle)
    projection = a_delta * cos_skin + b_delta * sin_skin

    # スキントーン方向に沿ったデルタのみ適用
    a_corrected = (a_orig - 128) + projection * cos_skin * mask + 128
    b_corrected = (b_orig - 128) + projection * sin_skin * mask + 128

    # マスク外は完全に元のまま
    a_result = a_orig * (1 - mask) + a_corrected * mask
    b_result = b_orig * (1 - mask) + b_corrected * mask

    return (
        np.clip(a_result, 0, 255).astype(np.float32),
        np.clip(b_result, 0, 255).astype(np.float32),
    )


def main():
    input_dir = Path(r"d:\LLM作業フォルダ\画像処理")
    input_file = input_dir / "2025 1114_MG_5181.jpg"
    output_file = input_dir / "2025 1114_MG_5181_graded.jpg"
    mask_file = input_dir / "2025 1114_MG_5181_graded_mask.jpg"

    print(f"入力: {input_file}")

    # --- 画像読み込み ---
    pil_image = Image.open(str(input_file))
    orig_size = pil_image.size
    print(f"画像サイズ: {orig_size[0]}x{orig_size[1]}")

    exif_data = pil_image.info.get('exif', None)
    icc_profile = pil_image.info.get('icc_profile', None)
    dpi = pil_image.info.get('dpi', (300, 300))
    print(f"DPI: {dpi}")
    if icc_profile:
        profile_name = "Adobe RGB" if b"Adobe RGB" in icc_profile else "sRGB" if b"sRGB" in icc_profile else "不明"
        print(f"ICCプロファイル: {profile_name} ({len(icc_profile)} bytes)")

    # --- Step 1: 顔セグメンテーション ---
    print("\n[Step 1] SegFormer 顔セグメンテーション...")
    processor, model, device = load_face_parser()
    labels, probs = segment_face(pil_image, processor, model, device)

    total_pixels = labels.size
    class_names = [
        "背景", "肌", "左眉", "右眉", "左目", "右目",
        "眼鏡", "左耳", "右耳", "イヤリング", "鼻",
        "口", "上唇", "下唇", "首", "ネックレス",
        "服", "髪", "帽子"
    ]
    unique_labels, counts = np.unique(labels, return_counts=True)
    print("  検出クラス:")
    for label, count in zip(unique_labels, counts):
        pct = count / total_pixels * 100
        if pct > 0.1:
            name = class_names[label] if label < len(class_names) else f"class_{label}"
            print(f"    {name}: {pct:.2f}%")

    # --- Step 2: マスク生成 ---
    print("\n[Step 2] マスク生成...")
    raw_mask = create_face_skin_mask(labels, probs)
    skin_only_mask = create_skin_only_mask(probs)

    # 暗さの重み付け（暗い顔部分だけにフォーカス）
    img_bgr = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l_ch = lab[:, :, 0].astype(np.float32)

    darkness_weight = np.clip((1.0 - l_ch / 255.0) ** 1.2, 0, 1)
    final_mask = raw_mask * darkness_weight

    # ブラー前に微小値をカット（遠方への漏れの種を排除）
    final_mask[final_mask < 0.10] = 0.0

    # なだらかなソフト化（境界を自然に、小さめカーネル）
    soft_ksize = max(orig_size) // 500
    if soft_ksize % 2 == 0:
        soft_ksize += 1
    if soft_ksize >= 3:
        final_mask = cv2.GaussianBlur(
            final_mask, (soft_ksize, soft_ksize), 0
        )
    if final_mask.max() > 0:
        final_mask = final_mask / final_mask.max()

    # パワーカーブで低い値を圧縮（テール除去）
    final_mask = final_mask ** 2.0

    # ブラー後にも微小値をカット（完全排除）
    final_mask[final_mask < 0.03] = 0.0

    cv2.imwrite(str(mask_file), (final_mask * 255).astype(np.uint8))
    print(f"  マスク保存: {mask_file}")

    dark_target = np.sum(final_mask > 0.3)
    print(f"  ターゲットピクセル: {dark_target:,} "
          f"({dark_target/total_pixels*100:.2f}%)")

    # --- Step 3: DaVinci Resolve スタイルのカラーグレーディング ---
    print("\n[Step 3] カラーグレーディング（DaVinci Resolve方式）...")

    a_ch = lab[:, :, 1].astype(np.float32)
    b_ch = lab[:, :, 2].astype(np.float32)

    # === グレーディングパラメータ自動算出 ===
    face_stats = analyze_face_luminance(l_ch, final_mask)
    if face_stats:
        target_l = calculate_target_luminance(face_stats)
        params = auto_grade_params(face_stats, target_l)

        print(f"  [輝度分析]")
        print(f"    平均: {face_stats['mean']:.1f}, 中央値: {face_stats['median']:.1f}")
        print(f"    P10: {face_stats['p10']:.1f}, P90: {face_stats['p90']:.1f}")
        print(f"    標準偏差: {face_stats['std']:.1f}")
        print(f"    目標輝度: {target_l:.1f} (現在{face_stats['mean']:.1f} → +{target_l - face_stats['mean']:.1f})")

        LIFT = params['lift']
        GAMMA = params['gamma']
        OFFSET = params['offset']
        SAT_BOOST = params['sat_boost']
    else:
        # フォールバック: マスク領域なし
        LIFT = 0.06
        GAMMA = 0.03
        OFFSET = 0.01
        SAT_BOOST = 0.05

    print(f"  [自動算出パラメータ]")
    print(f"    Lift:   +{LIFT}")
    print(f"    Gamma:  +{GAMMA}")
    print(f"    Offset: +{OFFSET}")
    print(f"    彩度:   +{SAT_BOOST*100:.1f}%")

    # Lift → Gamma → Offset の順で適用（DaVinci Resolveと同じ処理順）
    l_graded = apply_lift(l_ch, LIFT)
    l_graded = apply_gamma(l_graded, GAMMA)
    l_graded = apply_offset(l_graded, OFFSET)

    # マスクに基づいてブレンド（マスク外は1ピクセルも変更しない）
    l_result = l_ch * (1 - final_mask) + l_graded * final_mask

    # 彩度の微調整（スキントーン方向を維持）
    sat_factor = 1.0 + SAT_BOOST * final_mask
    a_adjusted = 128 + (a_ch - 128) * sat_factor
    b_adjusted = 128 + (b_ch - 128) * sat_factor

    # ベクトルスコープのスキントーンライン上に色を維持
    print("\n[Step 4] スキントーンベクトル補正...")
    a_result, b_result = preserve_skin_tone_vector(
        a_ch, b_ch, a_adjusted, b_adjusted, final_mask
    )

    # LABチャンネル再構成 → RGB変換
    lab_result = lab.copy()
    lab_result[:, :, 0] = np.clip(l_result, 0, 255).astype(np.uint8)
    lab_result[:, :, 1] = np.clip(a_result, 0, 255).astype(np.uint8)
    lab_result[:, :, 2] = np.clip(b_result, 0, 255).astype(np.uint8)
    graded_bgr = cv2.cvtColor(lab_result, cv2.COLOR_LAB2BGR)
    graded_rgb = cv2.cvtColor(graded_bgr, cv2.COLOR_BGR2RGB)

    # === 背景保護: マスク外は元画像のピクセルをそのまま使用 ===
    # 色空間変換の丸め誤差を完全に排除
    orig_rgb = np.array(pil_image)  # 元画像のRGB（変換なし）
    mask_3ch = np.stack([final_mask] * 3, axis=-1)

    # マスク外 = 元画像そのまま、マスク内 = グレーディング結果
    final_rgb = (
        orig_rgb.astype(np.float32) * (1 - mask_3ch)
        + graded_rgb.astype(np.float32) * mask_3ch
    )
    final_rgb = np.clip(final_rgb, 0, 255).astype(np.uint8)

    # --- Step 4.5: 肌スムージング ---
    SKIN_SMOOTH = 0.4  # 0.0〜1.0（0.3〜0.5が自然）
    print(f"\n[Step 4.5] 肌スムージング (strength={SKIN_SMOOTH})...")
    skin_pixels = np.sum(skin_only_mask > 0.5)
    print(f"  肌領域: {skin_pixels:,} px "
          f"({skin_pixels/total_pixels*100:.2f}%)")
    final_rgb = smooth_skin(final_rgb, skin_only_mask, SKIN_SMOOTH)

    # --- Step 5: 保存（TIFF無劣化 + JPEG高品質の両方） ---
    print("\n[Step 5] 保存...")
    pil_result = Image.fromarray(final_rgb)

    # TIFF版（完全無劣化）
    tiff_file = output_file.with_suffix('.tiff')
    tiff_kwargs = {'dpi': dpi}
    if exif_data:
        tiff_kwargs['exif'] = exif_data
    if icc_profile:
        tiff_kwargs['icc_profile'] = icc_profile
    pil_result.save(str(tiff_file), 'TIFF', **tiff_kwargs)
    print(f"  TIFF（無劣化）: {tiff_file}")

    # JPEG版（高品質）
    jpeg_kwargs = {'quality': 98, 'subsampling': 0, 'dpi': dpi}
    if exif_data:
        jpeg_kwargs['exif'] = exif_data
    if icc_profile:
        jpeg_kwargs['icc_profile'] = icc_profile
    pil_result.save(str(output_file), 'JPEG', **jpeg_kwargs)
    print(f"  JPEG（Q98）: {output_file}")
    print(f"  EXIF保持, DPI={dpi}, ICCプロファイル={'保持' if icc_profile else 'なし'}")
    print(f"  出力: {output_file}")

    # --- 統計 ---
    face_region = final_mask > 0.3
    if face_region.any():
        orig_mean = l_ch[face_region].mean()
        result_mean = lab_result[:, :, 0][face_region].mean()
        diff = result_mean - orig_mean
        print("\n[結果]")
        print(f"  顔領域の平均輝度: {orig_mean:.1f} → {result_mean:.1f} "
              f"(+{diff:.1f})")
        print(f"  変化率: {diff/orig_mean*100:.1f}%")

        # ベクトルスコープ上の肌色確認
        a_orig_mean = a_ch[face_region].mean()
        b_orig_mean = b_ch[face_region].mean()
        a_new_mean = lab_result[:, :, 1][face_region].astype(float).mean()
        b_new_mean = lab_result[:, :, 2][face_region].astype(float).mean()
        print(f"  肌色ベクトル (a,b): "
              f"({a_orig_mean-128:.1f}, {b_orig_mean-128:.1f}) → "
              f"({a_new_mean-128:.1f}, {b_new_mean-128:.1f})")

    del model, processor
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    print("\n完了！")


if __name__ == "__main__":
    main()
