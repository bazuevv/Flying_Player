/*
 * Кастомный JavaScript для webview расширения Claude Code (anthropic.claude-code).
 *
 * Канонический источник — этот файл. Хук .claude/hooks/patch-claude-webview.py
 * инлайнит его содержимое в bootstrap-блок внутри webview/index.js
 * (CSP блокирует <script src> к внешним webview-ресурсам).
 *
 * Конфигурация — `.claude/patches/claude-custom-config.toml`. Хук
 * подставляет её в bootstrap как `window.__CLAUDE_CUSTOM_CONFIG__`.
 * Поддерживаемые ключи:
 *   - logs (bool)            : включить/выключить console.log + warn
 *   - pollIntervalMs (int)   : период пуллинга CSS, мс (по умолчанию 5000)
 *   - throttleMs (int)       : минимальный интервал между обновлениями
 *                              CSS на DOM-мутациях, мс (по умолчанию 200)
 *
 * Workflow редактирования: правишь файл → новая сессия Claude Code или
 * UserPromptSubmit-хук синхронизирует его в webview → Reload Window /
 * закрыть-открыть панель Claude Code, чтобы перезапустился bootstrap.
 *
 * Для CSS отдельный reload не нужен — он горячо перезагружается через
 * <link rel="stylesheet"> с cache-bust query (пуллинг + DOM-мутации).
 */

(function () {
  if (window.__claudeCustomScriptInstalled) return;
  window.__claudeCustomScriptInstalled = true;

  var cfg = window.__CLAUDE_CUSTOM_CONFIG__ || {};
  var LOGS_ENABLED = cfg.logs === true;
  var POLL_MS = typeof cfg.pollIntervalMs === 'number' && cfg.pollIntervalMs > 0
    ? cfg.pollIntervalMs : 5000;
  var THROTTLE_MS = typeof cfg.throttleMs === 'number' && cfg.throttleMs >= 0
    ? cfg.throttleMs : 200;
  var VISIBILITY_REFRESH_DELAY_MS =
    typeof cfg.visibilityRefreshDelayMs === 'number' && cfg.visibilityRefreshDelayMs >= 0
      ? cfg.visibilityRefreshDelayMs
      : 0;
  var DEBUG_OVERLAY_ENABLED = cfg.debugOverlay === true;

  function logInfo() {
    if (!LOGS_ENABLED) return;
    try { console.log.apply(console, ['[claude-custom]'].concat([].slice.call(arguments))); } catch (_) {}
  }
  function logWarn() {
    if (!LOGS_ENABLED) return;
    try { console.warn.apply(console, ['[claude-custom]'].concat([].slice.call(arguments))); } catch (_) {}
  }

  /**
   * Помечает абзацы ассистентского сообщения, начинающиеся с эмодзи 📬,
   * классом `.claude-ts-line` (на него рассчитан CSS из claude-custom.css).
   */
  function tagTimestampLines() {
    var nodes = document.querySelectorAll(
      '[data-testid="assistant-message"] p:not(.claude-ts-line)'
    );
    for (var i = 0; i < nodes.length; i++) {
      var p = nodes[i];
      var text = (p.textContent || '').replace(/^[\s ]+/, '');
      if (text.indexOf('\u{1F4EC} ') === 0) {
        p.classList.add('claude-ts-line');
      }
    }
  }

  /**
   * Перевешивает <link rel="stylesheet"> к claude-custom.css с уникальным
   * query-параметром, чтобы браузер качал файл заново. <link> идёт под
   * CSP `style-src vscode-resource:` — это работает, в отличие от fetch
   * (его CSP `connect-src` режет). Старый <link> удаляется только после
   * успешной загрузки нового.
   *
   * Не делает refresh, если вкладка не активна (`document.visibilityState
   * !== 'visible'`) — фоновые webview-панели не дёргают диск и не плодят
   * `?t=…` URL'ы в DevTools Sources. При активации вкладки сработает
   * handler на `visibilitychange` (см. init), который догоняет CSS.
   */
  var lastCssRefresh = 0;
  function refreshCustomCss() {
    refreshCalls++;
    // visibilityState в Anthropic-webview всегда 'visible', поэтому
    // используем document.hasFocus(): только сфокусированная вкладка
    // VSCode действительно «активная». Это даёт нам нужное поведение —
    // refreshCustomCss работает только в активной вкладке.
    if (!document.hasFocus()) {
      refreshSkippedNotFocused++;
      return;
    }
    var now = Date.now();
    if (now - lastCssRefresh < THROTTLE_MS) {
      refreshSkippedThrottled++;
      return;
    }
    lastCssRefresh = now;
    refreshExecuted++;

    // Подстраховка: удалить «зависший» <style> от старой fetch-реализации,
    // если он остался в DOM — иначе он будет перебивать свежий <link>.
    var staleStyle = document.getElementById('claude-custom-style');
    if (staleStyle && staleStyle.parentNode) {
      staleStyle.parentNode.removeChild(staleStyle);
    }

    var existing = document.getElementById('claude-custom-css');
    if (!existing) return;
    var baseHref = (existing.href || '').split('?')[0];
    if (!baseHref) return;

    var fresh = document.createElement('link');
    fresh.rel = 'stylesheet';
    fresh.href = baseHref + '?t=' + now;
    fresh.onload = function () {
      if (existing.parentNode) existing.parentNode.removeChild(existing);
      fresh.id = 'claude-custom-css';
      logInfo('css link refreshed at', new Date().toISOString());
    };
    fresh.onerror = function () {
      if (fresh.parentNode) fresh.parentNode.removeChild(fresh);
      logWarn('css link load failed');
    };
    document.head.appendChild(fresh);
  }

  /**
   * Persistent debug-overlay в правом верхнем углу webview. Виден на
   * любой вкладке (активной и неактивной). Показывает обратный отсчёт
   * до следующего CSS-poll'а. При visibility-resume переключается в
   * режим «refresh через …» и потом возвращается в обычный режим.
   *
   * Стили инлайн (cssText), чтобы overlay не зависел от перезагружаемого
   * claude-custom.css.
   */
  var initTimeMs = Date.now();
  var lastPollAt = initTimeMs;
  var overlayMode = 'poll'; // 'poll' | 'visibility'
  var visibilityResumeAt = 0;

  // Диагностика — для понимания, почему visibility-resume countdown
  // не срабатывает в этом расширении (см. issue от 2026-04-28).
  var lastVisibilityState = document.visibilityState;
  var lastVisibilityChangeAt = null;
  var lastVisibilityChangeNewState = null;
  var visibilityChangeCount = 0;
  var lastFocusState = document.hasFocus();
  var lastFocusChangeAt = null;
  var focusChangeCount = 0;
  // Счётчики refreshCustomCss: показывают, что фильтры действительно
  // блокируют ненужные refresh'и.
  var refreshCalls = 0;
  var refreshSkippedNotFocused = 0;
  var refreshSkippedThrottled = 0;
  var refreshExecuted = 0;

  function ensureDebugOverlay() {
    var overlay = document.getElementById('claude-custom-debug');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'claude-custom-debug';
    overlay.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:99999;' +
      'background:rgba(0,0,0,0.85);color:#fff;' +
      'padding:8px 14px;border-radius:6px;' +
      'font:12px/1.4 monospace;pointer-events:none;user-select:none;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.5);' +
      'min-width:240px;text-align:left;white-space:pre;';
    if (document.body) {
      document.body.appendChild(overlay);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(overlay);
      });
    }
    return overlay;
  }

  function fmtAgo(tsMs) {
    if (tsMs == null) return '—';
    var s = Math.round((Date.now() - tsMs) / 1000);
    return s + 's ago';
  }

  function updateDebugOverlay() {
    var overlay = ensureDebugOverlay();
    var now = Date.now();

    // Текущее состояние фокуса (опрос — fallback, если событие focus не
    // приходит). Если значение поменялось — запишем как «событие».
    var currentFocus = document.hasFocus();
    if (currentFocus !== lastFocusState) {
      lastFocusState = currentFocus;
      lastFocusChangeAt = now;
      focusChangeCount++;
    }

    var lines = [];
    if (overlayMode === 'visibility') {
      var remainingV = Math.max(0, visibilityResumeAt - now);
      lines.push('Refresh через ' + (remainingV / 1000).toFixed(1) + 's (resume)');
      if (remainingV <= 0) overlayMode = 'poll';
    } else {
      var elapsed = now - lastPollAt;
      var remainingP = Math.max(0, POLL_MS - elapsed);
      lines.push('Refresh через ' + (remainingP / 1000).toFixed(1) + 's');
    }

    lines.push('—— diag ——');
    lines.push('visState: ' + document.visibilityState);
    lines.push('hasFocus: ' + currentFocus);
    lines.push('init: ' + fmtAgo(initTimeMs));
    lines.push('visChanges: ' + visibilityChangeCount + (lastVisibilityChangeAt ? ' (last ' + fmtAgo(lastVisibilityChangeAt) + ' → ' + lastVisibilityChangeNewState + ')' : ''));
    lines.push('focusChanges: ' + focusChangeCount + (lastFocusChangeAt ? ' (last ' + fmtAgo(lastFocusChangeAt) + ' → ' + (lastFocusState ? 'focus' : 'blur') + ')' : ''));
    lines.push('—— refresh ——');
    lines.push('calls: ' + refreshCalls);
    lines.push('skip (notFocused): ' + refreshSkippedNotFocused);
    lines.push('skip (throttle): ' + refreshSkippedThrottled);
    lines.push('executed: ' + refreshExecuted);

    overlay.textContent = lines.join('\n');
  }

  function init() {
    logInfo('init at', new Date().toISOString());
    var cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (cspMeta) logInfo('CSP:', cspMeta.content);

    tagTimestampLines();
    refreshCustomCss();

    new MutationObserver(function () {
      tagTimestampLines();
      // CSS-refresh здесь НЕ вызывается — иначе при стриминге ответа
      // ассистента DOM-мутации обходят таймер pollIntervalMs и цвет
      // обновляется «мгновенно». Refresh идёт только через setInterval
      // и visibilitychange — так таймер реально определяет момент
      // следующего обновления.
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Периодический пуллинг — для активных вкладок без DOM-активности.
    // refreshCustomCss сам выходит, если вкладка не visible.
    // lastPollAt тикается всегда, даже когда refresh — no-op (вкладка
    // скрыта), чтобы overlay-таймер был предсказуем.
    setInterval(function () {
      refreshCustomCss();
      lastPollAt = Date.now();
    }, POLL_MS);

    // Когда вкладка становится активной — делаем refresh, чтобы догнать
    // изменения CSS, накопленные за время неактивности. Задержка
    // VISIBILITY_REFRESH_DELAY_MS позволяет увидеть, как именно цвет
    // меняется. 0 — мгновенно.
    // visibilitychange в Anthropic-webview не срабатывает (state всегда
    // visible). Оставляем подписку только для диагностики — счётчик
    // в overlay помогает увидеть, если в каком-то будущем релизе
    // расширение начнёт его эмитить.
    document.addEventListener('visibilitychange', function () {
      visibilityChangeCount++;
      lastVisibilityChangeAt = Date.now();
      lastVisibilityChangeNewState = document.visibilityState;
      lastVisibilityState = document.visibilityState;
    });

    // Реальный триггер «возврат на вкладку» в этом расширении —
    // window-focus после blur. Первый focus при init не должен
    // считаться возвратом, поэтому через флаг seenBlurSinceLastFocus.
    var seenBlurSinceLastFocus = false;
    window.addEventListener('focus', function () {
      if (lastFocusState !== true) {
        lastFocusState = true;
        lastFocusChangeAt = Date.now();
        focusChangeCount++;
      }
      if (!seenBlurSinceLastFocus) return; // первый focus после init
      seenBlurSinceLastFocus = false;

      var doRefresh = function () {
        lastCssRefresh = 0;
        refreshCustomCss();
        lastPollAt = Date.now();
      };
      if (VISIBILITY_REFRESH_DELAY_MS > 0) {
        if (DEBUG_OVERLAY_ENABLED) {
          overlayMode = 'visibility';
          visibilityResumeAt = Date.now() + VISIBILITY_REFRESH_DELAY_MS;
        }
        setTimeout(doRefresh, VISIBILITY_REFRESH_DELAY_MS);
      } else {
        doRefresh();
      }
    });
    window.addEventListener('blur', function () {
      if (lastFocusState !== false) {
        lastFocusState = false;
        lastFocusChangeAt = Date.now();
        focusChangeCount++;
      }
      seenBlurSinceLastFocus = true;
    });

    // Persistent debug-overlay тикает каждые 100мс на любой вкладке —
    // только если включён в конфиге (debugOverlay=true). Иначе вообще
    // никаких overlay-элементов не создаётся.
    if (DEBUG_OVERLAY_ENABLED) {
      ensureDebugOverlay();
      setInterval(updateDebugOverlay, 100);
      updateDebugOverlay();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
