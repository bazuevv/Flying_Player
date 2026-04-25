# Плавающий видеоплеер «PiP-style» для Ubuntu

## Context

Пользователю нравится поведение Picture-in-Picture в Firefox (вынос видео YouTube в отдельное всплывающее окно поверх всех приложений) и он хочет получить такой же инструмент как самостоятельную утилиту для Ubuntu. По уточнённым требованиям:

- Источники: **локальные видеофайлы** и **прямые видео-URL** (HLS/MP4). YouTube/Twitch как обязательная фича не нужны (но автоматически заработают, если в системе есть `yt-dlp` — это бонус от mpv).
- Окно: **всегда поверх других**, **без рамок**, **перетаскивание мышью**, **изменение размера**.
- Запуск: **отдельный скрипт + `.desktop`-ярлык** (без интеграции с remap_x11_keys.py).
- Стек: на усмотрение (выбран Python + PyQt6 + libmpv — обоснование ниже).

Цель — получить лёгкую утилиту, которой можно открыть видео из файлового менеджера/буфера обмена и держать его поверх других окон во время работы.

## Выбранный подход

**Python 3 + PyQt6 + python-mpv (libmpv).**

Почему именно так:
- `mpv` через `libmpv` — единственный движок, который из коробки тянет всё нужное (локальные файлы, HLS, MP4, любые форматы ffmpeg) и нативно встраивается в чужое окно через параметр `wid`.
- PyQt6 даёт полный контроль над frameless-окном: easy `WindowStaysOnTopHint`, кастомный mouse-drag, `QSizeGrip` для ресайза, контекстное меню.
- Согласуется со стеком текущего проекта (Python).
- Один файл скрипта, без сборки.

Альтернативы (не выбраны):
- Голый `mpv --ontop --no-border` — у frameless-окна mpv плохо работает drag/resize без оконного менеджера, UX хуже Firefox PiP.
- GStreamer+GTK — больше boilerplate под видео.
- QtWebEngine — тяжёлые зависимости ради того, что mpv уже умеет.

## Структура проекта

Новая поддиректория в корне репозитория (изолированно от remap-скрипта):

```
floating_player/
├── floating_player.py        # основной скрипт
├── floating-player.desktop   # ярлык приложения
├── install.sh                # установка зависимостей + копирование .desktop
└── README.md                 # краткая инструкция (по запросу)
```

## Ключевые детали реализации

### Зависимости (Ubuntu)

Системные пакеты:
- `libmpv2` (на новых Ubuntu) или `libmpv1` (на старых) — собственно mpv-библиотека.
- `python3-pyqt6` — Qt-биндинги.
- `python3-mpv` — Python-обёртка над libmpv (или `pip install python-mpv`).
- (опционально) `yt-dlp` — для автоматической поддержки YouTube/Twitch, если когда-нибудь понадобится.

Проверка через `apt show libmpv2 python3-pyqt6 python3-mpv` перед установкой.

### floating_player.py — каркас

```python
#!/usr/bin/env python3
import sys, os, locale
from PyQt6.QtCore import Qt, QPoint, QEvent
from PyQt6.QtWidgets import QApplication, QWidget, QSizeGrip, QVBoxLayout, QMenu
from PyQt6.QtGui import QAction, QCursor
import mpv

class FloatingPlayer(QWidget):
    def __init__(self, source: str):
        super().__init__()
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool          # без значка в таскбаре
        )
        self.setAttribute(Qt.WidgetAttribute.WA_NativeWindow)
        self.setAttribute(Qt.WidgetAttribute.WA_DontCreateNativeAncestors)
        self.resize(480, 270)             # 16:9, удобный размер для угла экрана

        # mpv требует C-локаль
        locale.setlocale(locale.LC_NUMERIC, "C")

        self.player = mpv.MPV(
            wid=str(int(self.winId())),
            input_default_bindings=True,  # стандартные хоткеи mpv (пробел, стрелки)
            input_vo_keyboard=True,
            osc=True,                     # встроенный on-screen-controller
            keep_open="yes",
            ytdl=True,                    # бонус: YouTube заработает, если есть yt-dlp
        )

        # SizeGrip в правом нижнем углу для ресайза
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addStretch()
        grip = QSizeGrip(self)
        layout.addWidget(grip, 0, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignBottom)

        self._drag_pos: QPoint | None = None
        self.player.play(source)

    # --- Drag окна за тело видео ---
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_pos = e.globalPosition().toPoint() - self.frameGeometry().topLeft()
            e.accept()

    def mouseMoveEvent(self, e):
        if self._drag_pos and e.buttons() & Qt.MouseButton.LeftButton:
            self.move(e.globalPosition().toPoint() - self._drag_pos)
            e.accept()

    def mouseReleaseEvent(self, e):
        self._drag_pos = None

    # --- Контекстное меню (закрыть, pause, mute) ---
    def contextMenuEvent(self, e):
        m = QMenu(self)
        pause = QAction("Pause/Play", self, triggered=lambda: self.player.cycle("pause"))
        mute  = QAction("Mute/Unmute", self, triggered=lambda: self.player.cycle("mute"))
        close = QAction("Close",       self, triggered=self.close)
        m.addActions([pause, mute]); m.addSeparator(); m.addAction(close)
        m.exec(e.globalPos())

    # --- Esc закрывает окно ---
    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape:
            self.close()
        else:
            super().keyPressEvent(e)

def main():
    if len(sys.argv) < 2:
        print("usage: floating_player.py <file-or-url>", file=sys.stderr); sys.exit(2)
    source = sys.argv[1]
    if os.path.exists(source):
        source = os.path.abspath(source)
    app = QApplication(sys.argv)
    w = FloatingPlayer(source); w.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
```

Ключевые моменты:
- `WA_NativeWindow` обязателен, чтобы `winId()` отдавал реальный X11/Wayland window-id для mpv.
- `WindowType.Tool` — окно не появляется в таскбаре и переключателе Alt+Tab (поведение, как у PiP).
- `osc=True` — mpv сам рисует control-bar при наведении мыши, ничего вручную не верстаю.
- Drag реализован ровно как принято в frameless Qt-приложениях: запоминаем offset на mousePress и двигаем окно по mouseMove.
- `QSizeGrip` решает ресайз без своего mouse-tracking-кода.

### floating-player.desktop

```ini
[Desktop Entry]
Type=Application
Name=Floating Player
Comment=PiP-style always-on-top video player
Exec=/usr/local/bin/floating_player.py %U
Icon=video-x-generic
Terminal=false
Categories=AudioVideo;Video;Player;
MimeType=video/mp4;video/x-matroska;video/webm;video/quicktime;x-scheme-handler/file;
NoDisplay=false
```

Ставится в `~/.local/share/applications/floating-player.desktop`. Принимает `%U` — позволяет «Открыть с помощью…» из Nautilus.

### install.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
sudo apt update
sudo apt install -y python3-pyqt6 python3-mpv libmpv2 || \
sudo apt install -y python3-pyqt6 python3-mpv libmpv1
sudo install -m 755 floating_player.py /usr/local/bin/floating_player.py
mkdir -p ~/.local/share/applications
install -m 644 floating-player.desktop ~/.local/share/applications/floating-player.desktop
update-desktop-database ~/.local/share/applications || true
echo "Готово. Запуск: floating_player.py <файл-или-url>"
```

## Файлы, которые будут созданы

- `floating_player/floating_player.py` — основной скрипт (~120 строк).
- `floating_player/floating-player.desktop` — ярлык.
- `floating_player/install.sh` — установка.

Существующие файлы проекта (`remap_x11_keys.py`, `remap_config.yml`, и т.п.) **не трогаются**.

## Verification

End-to-end проверка после реализации:

1. **Установка зависимостей**
   ```
   cd floating_player && bash install.sh
   ```
2. **Воспроизведение локального файла**
   ```
   floating_player.py ~/Видео/sample.mp4
   ```
   Ожидание: появляется frameless-окно 480×270, поверх остальных, играет видео, OSC появляется при наведении мыши.
3. **Прямой URL (HLS/MP4)**
   ```
   floating_player.py "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
   ```
   Ожидание: HLS-поток воспроизводится без ошибок.
4. **Always-on-top**: открыть Firefox/терминал поверх → плеер не скрывается.
5. **Drag**: левая кнопка + движение → окно перемещается за курсором.
6. **Resize**: тянем правый-нижний угол (видна ручка `QSizeGrip`) → окно меняет размер.
7. **Закрытие**: `Esc` или ПКМ → Close — окно закрывается, процесс mpv корректно завершается (проверить `pgrep -af floating_player`).
8. **Ярлык**: в меню приложений Ubuntu появляется «Floating Player», ПКМ по видео в Nautilus → «Открыть с помощью…» → Floating Player.

## Открытые вопросы / оставлено на потом

- Запоминание позиции/размера окна между запусками (через `QSettings`) — не входит в MVP.
- Иконка приложения — пока используется системная `video-x-generic`.
- Хоткей-запуск из remap_x11_keys.py — пользователь явно сказал «отдельный скрипт + ярлык», поэтому не делаю; тривиально добавится позже одной строкой в `remap_config.yml`.
