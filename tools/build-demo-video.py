from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 1280, 720
BG = (10, 18, 32)
PANEL = (20, 31, 48)
PANEL_2 = (28, 43, 64)
TEXT = (240, 246, 255)
MUTED = (164, 180, 202)
BLUE = (79, 157, 255)
GREEN = (60, 205, 145)
AMBER = (255, 193, 87)
FONT = Path(r"C:\Windows\Fonts\msyh.ttc")
FONT_BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if bold and FONT_BOLD.exists() else FONT
    return ImageFont.truetype(str(path), size)


def rounded(draw: ImageDraw.ImageDraw, box, fill, radius=18, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def base(title: str, subtitle: str, step: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    # restrained background grid
    for x in range(0, WIDTH, 48):
        draw.line((x, 0, x, HEIGHT), fill=(15, 26, 42), width=1)
    for y in range(0, HEIGHT, 48):
        draw.line((0, y, WIDTH, y), fill=(15, 26, 42), width=1)
    draw.rectangle((0, 0, WIDTH, 6), fill=BLUE)
    draw.text((58, 34), "CODEX SSH PASSWORD CONNECT", font=font(18, True), fill=BLUE)
    draw.text((1070, 34), step, font=font(16, True), fill=MUTED)
    draw.text((58, 105), title, font=font(42, True), fill=TEXT)
    draw.text((60, 164), subtitle, font=font(22), fill=MUTED)
    rounded(draw, (58, 660, 1222, 698), (17, 29, 46), radius=12)
    draw.text((78, 669), "示例数据 · 不含真实服务器、账号、密码或项目内容", font=font(16), fill=MUTED)
    return image, draw


def scene_local() -> Image.Image:
    image, d = base("本机 Codex，项目留在服务器", "密码登录 · SSH/SFTP · 不复制整个仓库", "01 / 05")
    cards = [
        (70, 280, 390, 545, "本机", "Codex / VS Code", "模型与对话留在本机", BLUE),
        (445, 280, 835, 545, "本机连接桥", "SSH Password Connect", "本机输入密码 · 状态实时可见", GREEN),
        (820, 280, 1210, 545, "远程服务器", "gpu-dev.example.net", "代码、构建与执行留在服务器", AMBER),
    ]
    for x1, y1, x2, y2, label, title, detail, accent in cards:
        rounded(d, (x1, y1, x2, y2), PANEL, radius=22, outline=(54, 73, 96), width=2)
        d.rounded_rectangle((x1 + 22, y1 + 24, x1 + 34, y2 - 24), radius=6, fill=accent)
        d.text((x1 + 56, y1 + 42), label, font=font(18, True), fill=accent)
        d.text((x1 + 56, y1 + 100), title, font=font(25, True), fill=TEXT)
        d.multiline_text((x1 + 56, y1 + 160), detail, font=font(19), fill=MUTED, spacing=8)
    d.line((390, 410, 435, 410), fill=BLUE, width=4)
    d.polygon([(435, 410), (420, 400), (420, 420)], fill=BLUE)
    d.line((835, 410, 810, 410), fill=GREEN, width=4)
    d.polygon([(810, 410), (825, 400), (825, 420)], fill=GREEN)
    return image


def scene_password() -> Image.Image:
    image, d = base("认证材料留在本机", "密码登录，或选择本机私钥；都不会进入聊天", "02 / 05")
    rounded(d, (190, 245, 1090, 582), (233, 238, 246), radius=20)
    d.rounded_rectangle((190, 245, 1090, 305), radius=20, fill=(34, 63, 105))
    d.rectangle((190, 280, 1090, 305), fill=(34, 63, 105))
    d.text((224, 263), "Codex SSH · 输入服务器密码", font=font(20, True), fill=(255, 255, 255))
    d.text((234, 338), "SSH server: gpu-dev.example.net:2222", font=font(21), fill=(33, 47, 65))
    d.text((234, 389), "用户名", font=font(18), fill=(40, 52, 69))
    rounded(d, (380, 379, 1035, 427), (255, 255, 255), radius=8, outline=(154, 169, 190), width=2)
    d.text((402, 391), "developer", font=font(19), fill=(34, 47, 65))
    d.text((234, 452), "密码", font=font(18), fill=(40, 52, 69))
    rounded(d, (380, 442, 1035, 490), (255, 255, 255), radius=8, outline=(154, 169, 190), width=2)
    d.text((402, 450), "••••••••••", font=font(24), fill=(36, 55, 83))
    rounded(d, (785, 512, 916, 553), (46, 125, 222), radius=8)
    d.text((818, 520), "连接", font=font(18, True), fill=(255, 255, 255))
    d.text((934, 522), "本地对话框", font=font(17), fill=(81, 97, 117))
    d.text((234, 550), "或选择本机私钥 · 私钥留在电脑，服务器只配置公钥", font=font(15), fill=(55, 83, 117))
    return image


def scene_monitor() -> Image.Image:
    image, d = base("连接状态一眼可见", "监控器自动显示 Codex 聊天标题与 SSH 状态", "03 / 05")
    rounded(d, (74, 236, 1205, 574), (248, 250, 253), radius=18, outline=(104, 129, 160), width=2)
    d.rounded_rectangle((74, 236, 1205, 295), radius=18, fill=(237, 242, 249))
    d.rectangle((74, 270, 1205, 295), fill=(237, 242, 249))
    d.text((104, 252), "Codex SSH Monitor", font=font(19, True), fill=(35, 53, 76))
    d.text((104, 315), "聊天标题", font=font(16, True), fill=(69, 83, 101))
    d.text((355, 315), "服务器", font=font(16, True), fill=(69, 83, 101))
    d.text((692, 315), "用户 / 端口", font=font(16, True), fill=(69, 83, 101))
    d.text((908, 315), "状态", font=font(16, True), fill=(69, 83, 101))
    d.line((92, 346, 1185, 346), fill=(206, 215, 227), width=2)
    d.text((104, 365), "模型部署", font=font(19, True), fill=(33, 56, 83))
    d.text((355, 365), "gpu-dev.example.net", font=font(17), fill=(33, 56, 83))
    d.text((692, 365), "developer · 2222", font=font(17), fill=(33, 56, 83))
    rounded(d, (908, 358, 1037, 396), (217, 247, 235), radius=12)
    d.text((936, 366), "已连接", font=font(17, True), fill=(20, 133, 83))
    d.line((92, 416, 1185, 416), fill=(226, 232, 239), width=1)
    d.text((104, 435), "日志排查", font=font(19, True), fill=(33, 56, 83))
    d.text((355, 435), "gpu-dev.example.net", font=font(17), fill=(33, 56, 83))
    d.text((692, 435), "developer · 2222", font=font(17), fill=(33, 56, 83))
    rounded(d, (908, 428, 1037, 466), (217, 247, 235), radius=12)
    d.text((936, 436), "已连接", font=font(17, True), fill=(20, 133, 83))
    d.text((104, 514), "旧会话可从本机 Codex 历史匹配标题；连接元数据不会上传。", font=font(16), fill=(94, 109, 128))
    return image


def scene_files() -> Image.Image:
    image, d = base("按需读写，不镜像整个项目", "远程文件留在服务器；模型只拿当前需要的文本片段", "04 / 05")
    steps = [
        (70, 288, "读取区间", "最多 32 KiB / 次", BLUE),
        (470, 288, "流式补丁", "小片段编辑大文件", GREEN),
        (870, 288, "远程构建", "命令在服务器运行", AMBER),
    ]
    for x, y, title, detail, color in steps:
        rounded(d, (x, y, x + 330, y + 180), PANEL, radius=20, outline=(58, 76, 99), width=2)
        d.ellipse((x + 26, y + 26, x + 68, y + 68), fill=color)
        d.text((x + 84, y + 28), title, font=font(25, True), fill=TEXT)
        d.text((x + 28, y + 100), detail, font=font(19), fill=MUTED)
    for x in (402, 802):
        d.line((x, 378, x + 48, 378), fill=(119, 150, 185), width=4)
        d.polygon([(x + 48, 378), (x + 33, 369), (x + 33, 387)], fill=(119, 150, 185))
    rounded(d, (70, 510, 1200, 584), (18, 42, 56), radius=16, outline=(42, 101, 115), width=1)
    d.text((102, 529), "本机完整仓库副本：不需要", font=font(20, True), fill=(115, 224, 202))
    d.text((525, 532), "临时文件与原子替换需要服务器可用空间", font=font(18), fill=MUTED)
    return image


def scene_end() -> Image.Image:
    image, d = base("本机推理 · 远程执行", "密码或本机私钥认证；不在服务器安装 Codex", "05 / 05")
    rounded(d, (130, 262, 1150, 520), PANEL, radius=24, outline=(52, 74, 100), width=2)
    d.text((188, 312), "Connect", font=font(42, True), fill=BLUE)
    d.text((478, 312), "Inspect", font=font(42, True), fill=GREEN)
    d.text((766, 312), "Edit", font=font(42, True), fill=AMBER)
    d.text((930, 312), "Run", font=font(42, True), fill=TEXT)
    d.text((190, 410), "Local Windows MCP  ·  SSH/SFTP  ·  Codex approvals", font=font(22), fill=MUTED)
    d.text((190, 460), "Windows release · Codex desktop / VS Code Codex", font=font(18), fill=(120, 142, 170))
    return image


def main():
    parser = argparse.ArgumentParser(description="Build a short illustrative product demo video.")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "docs" / "demo.mp4")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    ffmpeg = shutil.which(args.ffmpeg)
    if not ffmpeg:
        raise SystemExit("ffmpeg was not found on PATH.")

    slides = [scene_local(), scene_password(), scene_monitor(), scene_files(), scene_end()]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    slides[2].save(args.output.parent / "demo-preview.png", format="PNG", optimize=True)
    with tempfile.TemporaryDirectory(prefix="codex-ssh-demo-") as temp_dir:
        temp = Path(temp_dir)
        frame_index = 0
        concat_lines = []
        for slide in slides:
            frame = temp / f"frame_{frame_index:04d}.png"
            slide.save(frame, format="PNG", optimize=True)
            concat_lines.append(f"file '{frame.as_posix()}'")
            concat_lines.append("duration 5")
            frame_index += 1
        concat_lines.append(f"file '{(temp / f'frame_{frame_index - 1:04d}.png').as_posix()}'")
        concat = temp / "frames.txt"
        concat.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
        command = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(concat),
            "-vf", "fps=30,format=yuv420p",
            "-t", str(len(slides) * 5),
            "-c:v", "libx264", "-preset", "medium", "-crf", "22",
            "-movflags", "+faststart",
            "-metadata", "title=Codex SSH Password Connect Demo",
            "-metadata", "comment=Illustrative demo with fictional sample data; no real credentials or server details.",
            str(args.output),
        ]
        subprocess.run(command, check=True)

    print(f"Created {args.output}")


if __name__ == "__main__":
    main()
