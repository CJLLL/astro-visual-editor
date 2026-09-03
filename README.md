# @maofuxing/astro-visual-editor

Astro 7 development adapter for the Maofuxing DSH visual editor. It adds
source-file markers to rendered elements and loads the picker from a local DSH
Host only when the page is opened by the visual editor.

## Install

```sh
npm install --save-dev @maofuxing/astro-visual-editor
```

## Configure

```js
import { defineConfig } from 'astro/config'
import astroVisualEditor from '@maofuxing/astro-visual-editor'

export default defineConfig({
  integrations: [
    astroVisualEditor({ projectRoot: import.meta.dirname }),
  ],
})
```

The Host origin is resolved from the explicit `host` option, then
`DSH_VISUAL_EDITOR_HOST`, and finally defaults to
`http://127.0.0.1:43120`. The integration is inactive for production builds.

## Security

- Use only a trusted loopback DSH Host.
- Source markers and the picker bootstrap are installed only by `astro dev`.
- The picker stays inert unless the page is in the named DSH iframe or carries
  the explicit `dsh-visual-editor=1` query parameter.
