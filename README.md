# BonXai Pruner ✂🌿

> **Podá tu feed de X (Twitter) con IA que corre en tu propio equipo.**
> Gemini Nano integrado en Chrome · 100% local · sin API keys · gratis.

*English summary at the end.*

---

## Qué hace

BonXai Pruner es una extensión de Chrome (Manifest V3) que lee cada post de **x.com** mientras scrolleás y decide si lo mostrás o no según **filtros escritos en lenguaje natural**:

- **Ocultar** un tema: “debates políticos, elecciones o peleas partidarias”.
- **Solo mostrar** un tema (feed curado): “anuncios de tecnología, lanzamientos de software o papers”.

El tipo de filtro (Ocultar / Solo mostrar) se elige explícitamente en el popup; nunca se adivina a partir del texto. Si tenés varios “Solo mostrar”, elegís si el post tiene que cumplir **cualquiera** o **todos**.

La clasificación la hace **Gemini Nano**, el modelo que Chrome trae integrado (Prompt API). Ni tus posts ni tu historial salen de tu computadora.

### Funciones

| | |
|---|---|
| 🫥 **Nada de saltos** | Mientras el modelo decide, el post se ve desenfocado con un aviso “BonXai evaluando…”. |
| 📎 **Colapsar con motivo** | El post oculto queda como una barra de una línea: *“BonXai ocultó un post de @x · Coincide con ‘Sin política’”*, con botón **Mostrar**. (O, si preferís, se quita del todo.) |
| 📋 **Lista de ocultados** | El popup muestra los últimos posts ocultados, con el motivo y un link al post. |
| 👍 **Corrección con un clic** | “No debía ocultarse” deja el post visible y guarda el caso como **ejemplo (few-shot)** para que el modelo no repita el error. |
| 👤 **Autores sin IA** | Listas de “Nunca filtrar a” y “Ocultar siempre a” (@usuarios). Se aplican antes del modelo, sin gastar inferencias. |
| 🖼️ **Fotos y videos** | Reglas explícitas: ocultar posts con imágenes / con video / sin media. Opcionalmente, **analizar la imagen** con la IA cuando el texto no alcanza (si el modelo de tu Chrome acepta imágenes). |
| 🌿 **Feed curado** | Con filtros **Solo mostrar**, los posts que coinciden se juntan en una vista propia (panel lateral de Chrome o pestaña), con chips por tema, búsqueda y link al post. Se guarda solo en tu equipo (últimos 200). |
| ✂ **Ocultar posts como este** | Cada post visible tiene un botón discreto (aparece al pasar el mouse): elegís a qué filtro pertenece (se guarda como ejemplo) o creás un **filtro nuevo** con el tema que propone el modelo local. Se puede deshacer. |
| 👍 **Corrección con varios “Solo mostrar”** | Si tenés varios temas en modo *cualquiera*, “No debía ocultarse” pregunta **de qué tema es** para guardar el ejemplo correcto. |
| ⚡ **Caché persistente** | Cada post se clasifica una vez por combinación de filtros, ejemplos y motor. La caché vive en `chrome.storage.local` (máx. 3000 entradas, 3 días), así que sobrevive a reinicios del service worker y del navegador. |
| 🔒 **Falla de forma segura** | Si el modelo no está, falla o no se descargó, **no se oculta nada por IA** y el popup muestra el estado real. |
| 🇦🇷 **Español e inglés** | Presets en español y sesión del modelo declarada para `en` + `es`. |
| 🧪 **Evaluación** | Set etiquetado + página de evaluación con **precisión y recall** por tema. |
| 🏠 **Motor local alternativo (opcional)** | Si tu equipo no corre Gemini Nano, podés usar un modelo propio en `localhost` (por ejemplo [Ollama](https://ollama.com)). Sigue siendo local y gratis; no se aceptan endpoints en la nube. |

---

## Requisitos (según la documentación oficial de Chrome)

BonXai usa la [Prompt API](https://developer.chrome.com/docs/extensions/ai/prompt-api) (el objeto global `LanguageModel`), disponible para extensiones desde **Chrome 138**.

- **Navegador**: Google Chrome **138 o superior** de escritorio. No funciona en Chrome para Android, iOS ni ChromeOS fuera de Chromebook Plus.
- **Sistema**: Windows 10/11; macOS 13+ (Ventura o posterior); Linux; o ChromeOS (Platform 16389.0.0+) en Chromebook Plus.
- **Disco**: al menos **22 GB libres** en el volumen del perfil de Chrome (el modelo es más chico, pero si quedan menos de 10 GB libres Chrome lo borra).
- **GPU o CPU**: GPU con **más de 4 GB de VRAM**, o CPU con **16 GB de RAM y 4 núcleos o más**.
- **Red**: conexión sin límite de datos para la descarga inicial del modelo. Después funciona offline.

El tamaño exacto del modelo cambia con las versiones de Chrome; lo ves en `chrome://on-device-internals`.

---

## Instalación (sin empaquetar)

BonXai se instala en modo desarrollador; no está publicado en ninguna tienda.

1. Cloná el repo:
   ```bash
   git clone https://github.com/ondanueve/BonXai-Pruner.git
   ```
2. Abrí `chrome://extensions`, activá **Modo de desarrollador** (arriba a la derecha).
3. Tocá **Cargar descomprimida** y elegí la carpeta `extension/`.
4. Fijá el ícono de BonXai en la barra (pieza de rompecabezas → pin).

### Descargar el modelo

1. Abrí el popup de BonXai. Arriba vas a ver el estado de Gemini Nano.
2. Si dice que falta descargarlo, tocá **Descargar modelo** (Chrome solo empieza la descarga después de un clic; el popup muestra el progreso).
3. Cuando diga **Gemini Nano listo**, entrá a x.com y scrolleá.

### Si el modelo figura como no disponible

En Chrome 138+ estable no hacen falta flags. Si tu equipo cumple los requisitos y aun así no aparece, probá:

- `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
- `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement** (solo para pruebas)

Reiniciá Chrome y revisá `chrome://on-device-internals`.

---

## Uso

1. En el popup, activá o creá filtros. Cada uno tiene **nombre**, **descripción del tema** y **tipo** (Ocultar / Solo mostrar).
2. Ajustá, si querés, **Fotos y videos**, **Autores** y **Opciones** (colapsar o quitar; motor de IA).
3. Tocá **Aplicar**. El feed se vuelve a evaluar al instante.
4. En cada post oculto: **Mostrar**, **No debía ocultarse** (corrige y enseña) o **Nunca filtrar a @usuario**.
5. En cada post visible: **✂ Ocultar posts como este** → “Es ‘Sin política’” / “No es ‘Tech’” (ejemplo para un filtro existente) o **+ Nuevo filtro con este tema**.
6. **🌿 Abrir feed curado** (popup) abre el panel lateral con lo que pasó tus filtros *Solo mostrar*. “No es de este tema” lo saca y enseña al modelo.

### Motor local con Ollama (opcional)

1. Instalá [Ollama](https://ollama.com) y bajá un modelo, por ejemplo `ollama pull gemma3:4b` (para imágenes, uno con visión).
2. Permití que la extensión le hable: arrancá Ollama con `OLLAMA_ORIGINS=chrome-extension://*`.
3. En **Opciones → Motor de IA** elegí “Modelo local propio”, revisá endpoint y modelo, y tocá **Aplicar** (Chrome te pide permiso para `localhost`).

---

## Evaluación (precisión / recall)

`extension/eval/dataset.json` tiene 40 posts **sintéticos** (escritos y etiquetados a mano, en español e inglés) para 5 temas. No son tweets reales: sirven para comparar cambios de prompt o de modelo, no como medida absoluta. Conviene ampliarlo con posts reales.

- **Gemini Nano real**: popup → Opciones → **Evaluar el modelo** (abre `eval.html` dentro de la extensión, porque la Prompt API solo existe en Chrome). Muestra precisión, recall y F1 por tema, los errores, y permite bajar el resultado en JSON.
- **Modelo en localhost**: `npm run eval -- --provider ollama --model gemma3:4b`
- **Sin modelo**: `npm run eval` corre una línea base de palabras clave (mock). Esos números **no** dicen nada de la calidad de Gemini Nano; solo prueban que el pipeline funciona.

El repo no publica números de Gemini Nano: corré la evaluación en tu equipo.

---

## Cómo funciona

```
extension/
├── manifest.json          # Manifest V3 (Chrome 138+)
├── background.js          # Service worker: dueño del modelo, caché y ejemplos
├── content.js             # En x.com: observa posts, blur, colapsar, correcciones
├── popup.html/.css/.js    # Filtros, reglas, estado del modelo, lista de ocultados
├── feed.html/.css/.js     # Feed curado (panel lateral o pestaña)
├── eval.html / eval.js    # Evaluación con el modelo real
├── eval/dataset.json      # Set etiquetado (sintético)
├── lib/
│   ├── rules.js           # Settings y reglas deterministas (autores, media, modos)
│   ├── tweet.js           # Extracción del post desde el DOM de X (todos los selectores)
│   ├── classifier.js      # Prompt, JSON Schema, parseo, caché LRU persistente
│   ├── providers.js       # Gemini Nano (Prompt API) y modelo en localhost
│   └── metrics.js         # Precisión / recall
└── icons/
```

1. `content.js` detecta cada `<article>` nuevo (MutationObserver) y extrae ID, autor, texto, alt text e imágenes (`lib/tweet.js`).
2. **Reglas sin IA** primero (`lib/rules.js`): correcciones previas, autores, reglas de media, posts sin texto.
3. Si hace falta IA, el post se desenfoca y se manda al **service worker** (los content scripts no pueden usar la Prompt API).
4. El worker arma una pregunta acotada: *para cada tema, ¿este post coincide?* La respuesta sale como objeto JSON de booleanos forzado con `responseConstraint` (JSON Schema). Cada post usa un `clone()` limpio de una sesión base con el system prompt. Las correcciones del usuario entran como ejemplos.
5. La decisión mostrar/ocultar se toma en código (`finalDecide`): un “Ocultar” que coincide gana; los “Solo mostrar” se combinan con *cualquiera* o *todos*.
6. El resultado se cachea por ID de tweet + filtros + ejemplos + motor, en `chrome.storage.local` con TTL de 3 días.
7. Los posts que pasan por un “Solo mostrar” se anotan en `curatedLog` para el feed curado; los que ocultás a mano, en `hiddenIds`.

Todo se guarda en `chrome.storage.local`. No hay servidores ni telemetría.

---

## Desarrollo

```bash
npm install
npm run check      # node --check de todos los JS
npm run validate   # manifest, archivos referenciados, íconos, límites
npm test           # tests unitarios y de DOM (jsdom) con modelo simulado
npm run eval       # evaluación con la línea base mock
npm run e2e        # Chrome headless real + modelo simulado en el service worker (CHROME_PATH=...)
```

---

## English summary

BonXai Pruner is a Manifest V3 Chrome extension that filters your X feed with Chrome's built-in **Gemini Nano** (Prompt API, `LanguageModel`, Chrome 138+). Filters are natural-language topics with an explicit mode (**hide** or **show only**). Posts are blurred while being classified, then collapsed into a one-line bar with the reason and a **Show** button. It includes a list of hidden posts, one-click corrections used as few-shot examples, author allow/block lists (no AI), explicit photo/video rules, optional image analysis, a curated feed view for "show only" topics (Chrome side panel or tab), a "Hide posts like this" button on visible posts (adds a few-shot example to a filter or creates a new filter with a topic suggested by the local model), a topic picker for corrections when several "show only" filters are combined with *any*, a per-tweet cache persisted in `chrome.storage.local` (3,000 entries, 3-day TTL) that survives service worker restarts, fail-open behaviour, an evaluation page with precision/recall on a small synthetic labelled set, and an optional local engine (any OpenAI-compatible server on `localhost`, e.g. Ollama). No cloud, no API keys. Install it unpacked from the `extension/` folder.

## Licencia

MIT. Ver [`LICENSE`](./LICENSE).
