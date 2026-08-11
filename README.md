# LunaCode

Рабочее пространство разработчика с встроенным ИИ-агентом поверх VS Code —
альтернатива Replit / Cursor, работающая как расширение VS Code.

## Возможности

1. **Запуск внутри VS Code** — обычное расширение, устанавливается и работает
   как часть VS Code (Desktop и `code-server` / веб-версия).
2. **Гибкая настройка ИИ-агента** — в настройках (`lunacode.*`) выбирается
   провайдер: `anthropic`, `openai` или `custom-openai-compatible`
   (подходит для локальных моделей: Ollama, LM Studio, vLLM, любой
   OpenAI-совместимый сервер). Ключ хранится отдельно на провайдера в
   защищённом `SecretStorage` VS Code.
3. **Чат с ИИ** — отдельная панель в Activity Bar слева ("LunaCode").
4. **Терминал** — команда `LunaCode: Открыть терминал` открывает
   именованный интегрированный терминал VS Code (полностью совместим с
   обычным терминалом VS Code: shell, ANSI, история и т.д.).
5. **Файловая структура** — используется нативный Explorer VS Code;
   добавлены команды `LunaCode: Новый файл` / `LunaCode: Новая папка` в
   контекстном меню проводника.

## Установка и запуск

```bash
cd lunacode
npm install
npm run compile
```

Затем в VS Code: `F5` (Run Extension) — откроется Extension Development
Host с активным LunaCode. Либо собрать `.vsix`:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension lunacode-0.1.0.vsix
```


## Веб-версия LunaCode

Помимо VS Code расширения в проект добавлена статическая веб-версия интерфейса:

```bash
npm run web
# или для production/Railway:
npm start
```

Локально откройте `http://localhost:4173/web/` — вы увидите рабочее пространство в стиле VS Code, стилизованное под LunaCode: activity bar, explorer, редактор и правую панель чата. Панель чата использует тот же `media/main.js` и `media/style.css`, что и webview расширения, поэтому изменения UI/UX остаются общими для VS Code и браузера.


Для Railway в репозитории есть сразу несколько явных подсказок запуска (`railway.json`, `nixpacks.toml`, `Procfile`): они запускают `npm start`, поэтому контейнер стартует веб-сервером, а не пытается выполнить VS Code entrypoint `out/extension.js`. Сервер слушает `process.env.PORT` на `0.0.0.0` и отдаёт healthcheck `/healthz`. `main` в `package.json` остаётся `./out/extension.js`, потому что это необходимо для работы расширения VS Code.

В браузере нажмите бейдж модели сверху и задайте OpenAI-compatible `chat/completions` URL, модель и API-ключ. Настройки, история и счётчики сохраняются только в `localStorage` текущего браузера. Файловые инструменты agent-режима и терминал намеренно доступны только в VS Code расширении, чтобы веб-страница не получала прямой доступ к файловой системе пользователя.

## Настройка ИИ-агента

1. Команда `Ctrl+Shift+P` → `LunaCode: Настройки подключения ИИ` — выбрать
   провайдера, модель, `baseUrl` (для своих серверов), системный промпт.
2. Команда `Ctrl+Shift+P` → `LunaCode: Указать API-ключ ИИ-агента` — ввести
   ключ (хранится зашифрованным, не в settings.json).
3. Открыть панель LunaCode на боковой панели и писать в чат.

### HHChat Pro (hhchat.xyz) — готовый провайдер

LunaCode поддерживает шлюз [HHChat Pro](https://hhchat.xyz) как отдельного
провайдера "из коробки" — он даёт доступ к Claude, GPT, Gemini, DeepSeek,
Grok и Kimi по одному ключу через OpenAI-совместимый API.

1. `Ctrl+Shift+P` → `LunaCode: Настройки подключения ИИ` → поле
   **Provider** установить в `hhchat`.
2. `Ctrl+Shift+P` → `LunaCode: Указать API-ключ ИИ-агента` → вставить свой
   токен от hhchat.xyz.
3. `Ctrl+Shift+P` → `LunaCode: Выбрать модель` — появится список всех
   моделей из их каталога (Claude Sonnet 5, GPT-5.5, Gemini 2.5 Pro,
   DeepSeek V4, Grok 4.5, Kimi K3 и т.д.) — выбрать нужную.
4. `Ctrl+Shift+P` → `LunaCode: Проверить баланс HHChat Pro` — покажет
   остаток токенов (эндпоинт `/v1/token-balance`).
5. Открыть панель LunaCode и писать в чат.

Base URL (`https://hhchat.xyz/v1/chat/completions`) подставляется
автоматически — руками указывать `baseUrl` не нужно, если только сервис не
сменит адрес.

### Пример для локальной модели (Ollama)

```json
{
  "lunacode.provider": "custom-openai-compatible",
  "lunacode.baseUrl": "http://localhost:11434/v1/chat/completions",
  "lunacode.model": "llama3.1"
}
```

Ключ для этого провайдера можно указать любой непустой (Ollama его не
проверяет), либо доработать `aiClient.ts` под сервер без авторизации.

## Структура проекта

```
lunacode/
  package.json         манифест расширения, команды, настройки
  src/extension.ts      точка входа: терминал, файлы, команды
  src/chatViewProvider.ts  webview-панель чата
  src/aiClient.ts       универсальный клиент под Anthropic/OpenAI/кастом
  media/                HTML/CSS/JS чата и иконка
```

## Новые возможности

### 1. Стриминг ответов
Ответы ИИ (в обычном режиме, без агента) печатаются по мере генерации, а
не появляются целиком после ожидания — как в ChatGPT/Claude.ai. Работает
для всех провайдеров через SSE (`stream: true`).

### 2. Отправка выделенного кода в чат
Выделите код в редакторе → правой кнопкой → **LunaCode: Отправить
выделение в чат**, либо горячая клавиша `Ctrl+Alt+L` (`Cmd+Alt+L` на
macOS). Код вставится в поле ввода чата как блок кода — допишите вопрос
и отправьте.

### 3. Agent-режим (работа с файлами)
Чекбокс **«Agent-режим»** над полем ввода чата включает tool-calling:
модель сама решает, когда прочитать файл, посмотреть содержимое папки,
создать файл/папку или переписать существующий файл — как в Cursor
Composer. Инструменты: `list_directory`, `read_file`, `write_file`,
`create_directory`.

**Важно про безопасность:** любая запись файла или создание папки требует
явного подтверждения через модальное окно VS Code — агент никогда не
меняет файлы без вашего разрешения. В agent-режиме ответы не стримятся
(вместо этого показываются шаги: какой инструмент вызван и что он вернул),
так как одновременно стримить текст и обрабатывать вызовы инструментов
у большинства провайдеров нельзя.

### 4. Персистентная история чата
История сообщений сохраняется в `workspaceState` VS Code — значит она
привязана к конкретному открытому проекту и переживает перезапуск VS
Code. При открытии проекта в LunaCode вы увидите тот же чат, что оставили
в прошлый раз. Команда `LunaCode: Очистить чат` стирает историю для
текущего workspace. Состояние чекбокса Agent-режима тоже запоминается.

## Исправление: пустой ответ у reasoning-моделей

Некоторые модели (Kimi K3, DeepSeek R1 и другие "thinking"-модели) отдают
текст не в стандартном поле `content`, а в отдельном `reasoning` /
`reasoning_content` (OpenAI-совместимые шлюзы) или через `thinking_delta`
(Anthropic с extended thinking). Раньше LunaCode читал только `content` и
показывал "(пустой ответ)", даже если токены были потрачены и модель что-то
ответила.

Теперь:
- Оба потока (обычный текст и рассуждения) читаются раздельно.
- Рассуждения показываются в сворачиваемом блоке **🧠 Thought** над ответом.
- Если модель вообще не прислала обычный `content` (весь ответ ушёл в
  рассуждения) — LunaCode автоматически использует текст рассуждений как
  финальный ответ, чтобы вы не видели пустое сообщение.

## Обновлённый интерфейс чата

Внешний вид панели переработан ближе к тому, как выглядит Continue:

- **Header:** переключатель режима **💬 Chat / 🤖 Agent** (сегментированные
  кнопки вместо чекбокса) слева и бейдж текущей модели справа — клик по
  бейджу сразу открывает выбор модели (`LunaCode: Выбрать модель`).
- **Сообщения:** аккуратные пузыри с моноширинным рендером блоков кода
  (```` ```lang ```` из ответа модели отображается как code-блок, а не как
  сплошной текст).
- **Thought:** сворачиваемый блок рассуждений модели, если она их присылает
  отдельно от финального ответа.
- **Footer:** строка статистики токенов сверху, под ней — строка ввода с
  кнопкой быстрого открытия терминала слева и кнопкой отправки справа,
  поле ввода само растёт по высоте при вводе многострочного текста.

Полноценная страница настроек (как разделы Models/Rules/Tools/Configs у
Continue) в этой версии не реализована — все настройки LunaCode пока идут
через стандартные VS Code Settings (`lunacode.*`) и команды палитры. Это
можно сделать следующим шагом, если нужно.

## Доработки agent-режима

### Diff перед записью файла
Когда агент хочет создать или переписать файл, LunaCode сначала открывает
стандартную diff-вкладку VS Code (старое содержимое слева, предложенное
агентом — справа, для нового файла слева пусто) и только после этого
показывает модальное окно подтверждения. Вы всегда видите точные изменения
построчно, а не просто путь к файлу.

### Инструмент «выполнить команду»
В agent-режиме модель может вызвать `run_terminal_command` (например
`npm test`, `npm install`, `git status`). Как и запись файлов, это
**всегда** требует подтверждения — в модальном окне показывается точная
команда перед запуском. Команда выполняется в корне workspace с таймаутом
30 секунд, вывод (stdout/stderr) возвращается модели и виден в чате как
шаг агента.

### Счётчик токенов и примерная стоимость
Под чекбоксом Agent-режима отображается строка с количеством токенов:
суммарно за сессию и по последнему запросу. Если провайдер возвращает
точные цифры (Anthropic, OpenAI, HHChat Pro в потоковом режиме через
`stream_options.include_usage`) — показываются они; если нет — грубая
оценка по длине текста (помечена как «оценка»).

Стоимость в USD не встроена жёстко (у разных моделей/провайдеров разный
прайс, и он меняется), но её можно включить самостоятельно в настройках:

```json
{
  "lunacode.pricePerMillionInputTokens": 3,
  "lunacode.pricePerMillionOutputTokens": 15
}
```

Счётчик накапливается по проекту (как история чата) и сбрасывается
кнопкой ↺ рядом со строкой статистики.

## Дальнейшее развитие (по желанию)

- Мульти-сессии чата (несколько параллельных чатов/вкладок).
- Стриминг и в agent-режиме одновременно с вызовом инструментов (сейчас
  agent-режим показывает пошаговый прогресс вместо токен-стрима — так
  проще и надёжнее совместить с tool calling у большинства провайдеров).
- Автоматическое определение цены по названию модели у известных
  провайдеров (сейчас цена вводится вручную для точности).

## Architecture modernization audit (2026-08-10)

Проведён аудит исходного расширения перед рефакторингом. Главные выводы:

- Архитектура была слишком плоской: provider-specific HTTP, agent loop, usage accounting и tool schemas жили преимущественно в `aiClient.ts`, а WebView управлял состоянием запросов без полноценной отмены.
- Tool system был статическим массивом: новые инструменты нельзя было регистрировать независимо, не было категорий, safe-for-parallel metadata и единой точки расширения под MCP.
- Path traversal защита ограничивалась `Uri.joinPath(root, clean)`, что недостаточно для строгого запрета выхода за workspace.
- Context management был почти отсутствующим: история просто обрезалась до 60 сообщений, без активного файла, selection, diagnostics, git/context budget и dedupe.
- Agent loop имел лимит шагов, но не имел AbortController, повторяемость tool calls не анализировалась, параллельность и permissions не моделировались как отдельные подсистемы.
- Terminal tool использовал одноразовый `exec()` без typed exit code/timeout policy/cancellation metadata и без базовой классификации опасных команд.
- WebView имел CSP и textContent-based рендеринг кусков markdown, но не имел Stop button, request lifecycle UI и строгой проверки входящих сообщений.
- Persistence была односессионной: отсутствовали несколько чатов, rename/delete/duplicate/search и context compaction.

## Новая архитектурная основа

Рефакторинг добавил модульные подсистемы, сохранив существующие команды, HHChat/OpenAI/Anthropic настройки, streaming и agent-mode:

```text
src/
  core/
    agent/              future orchestration boundary
    context/            context budget manager
    errors/             typed LunaCode errors
    permissions/        permission boundary placeholder
    providers/          AIProvider interfaces, model capabilities, request/stream types
    sessions/           session boundary placeholder
    tools/              ToolDefinition/LunaTool/ToolRegistry
  context/              ContextManager for active editor, selection, open files, diagnostics
  providers/
    hhchat/             HHChat model catalog isolated from generic AI client
  tools/
    diagnostics/        get_diagnostics
    filesystem/         list/read/range/write/create tools with safe path resolving
    git/                git_status/git_diff/git_log/git_show/git_branch/git_blame
    search/             search_files/search_text
    terminal/           cancellable terminal command tool with timeout and safety prompt
    registry/           default tool registration composition root
  utils/                workspace-safe path resolver and binary detection
```

### Реализованные foundational возможности

- `ToolRegistry` регистрирует инструменты независимо (`toolRegistry.register(tool)`) и хранит metadata: категория, readonly/write, safeForParallel.
- Добавлены workspace-aware инструменты: `search_files`, `search_text`, `read_file_range`, `read_lines`, `get_diagnostics`, `git_status`, `git_diff`, `git_log`, `git_show`, `git_branch`, `git_blame`.
- File tools теперь используют строгий `safeResolveWorkspacePath()`, который резолвит путь через `path.resolve()` и запрещает выход за корень workspace.
- `read_file` возвращает metadata, ограничивает объём ответа и распознаёт бинарные файлы.
- Terminal tool перешёл на `spawn()` с timeout, stdout/stderr, exit code, AbortSignal и предупреждением для потенциально опасных команд.
- Chat/agent requests получили Stop lifecycle: WebView показывает кнопку Stop, extension host держит `AbortController`, streaming reader и tools получают signal.
- Добавлен `ContextBudgetManager` и `ContextManager` как база для релевантного контекста: активный файл, выделение, открытые файлы, diagnostics и token budget.
- Добавлены VS Code-native команды и Code Actions для selection workflows: `LunaCode: Edit Selection`, explain, fix, generate tests.
- Добавлен `npm test` с unit smoke-тестом context budget manager.

### Что это даёт относительно Continue-like планки

Эта версия — не финальная реализация всех 12 фаз, а рабочий архитектурный фундамент: LunaCode уже перестал быть монолитным WebView+fetch и получил расширяемое ядро tools/context/provider contracts. Следующие фазы могут добавлять полноценный session manager, provider implementations на интерфейсе `AIProvider`, MCP adapters, diff accept/reject queue, inline completion cache и UI session selector без переписывания agent engine заново.
