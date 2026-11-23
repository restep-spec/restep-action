# restep-action

GitHub Action compuesta que comprueba una API Restep 1 en cada pull request:

1. Arranca la API (`start-command`) y espera a que responda (`wait-for`), o usa una que ya
   esté levantada (`url`).
2. Ejecuta [restep-check](https://www.npmjs.com/package/restep-check) con `--json`
   (y `--writes` si se pide) y comprueba que la API anuncia los perfiles de `profiles`.
3. Si se le da el descubrimiento de la rama base (`base-discovery`), lo compara con el actual
   con `restep-diff` y marca los cambios incompatibles (§5.5).
4. Escribe el resultado en el resumen del job, con la versión que declara la API en `restep`
   (§1.1: un `1.0-draft.6` o un `1.0-rc.1` sale como borrador o candidata, sin las garantías de
   una versión publicada, y una versión mayor distinta de 1, o que no sigue la gramática, como
   «no es Restep 1») (`$GITHUB_STEP_SUMMARY`), con una anotación por
   cada DEBE que falla, y, con `comment: true`, como comentario de la PR, siempre el mismo
   (uno por URL de API), que se actualiza en cada ejecución.
5. Para la API, aunque algo haya fallado.

Los pasos son `node action.mjs <paso>` (Node 18+, sin dependencias; los runners de GitHub
traen Node). Los inputs llegan a los scripts como variables de entorno, nunca interpolados en
el código de shell.

## Ejemplo

```yaml
# .github/workflows/restep.yml
name: Restep
on: pull_request

permissions:
  contents: read
  pull-requests: write   # solo para comment: true

jobs:
  restep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci

      # El descubrimiento de la rama base, si el repositorio lo guarda en un archivo.
      - name: Descubrimiento base
        run: git show "origin/${{ github.base_ref }}:api/discovery.json" > "$RUNNER_TEMP/base.json"

      - uses: restep-spec/restep-action@v0   # o la ruta a esta carpeta: ./tools/restep-action
        with:
          url: http://localhost:3000/
          start-command: npm start
          wait-for: http://localhost:3000/health
          profiles: core,query,writes
          writes: true
          base-discovery: ${{ runner.temp }}/base.json
          comment: true
          headers: |
            Authorization: Bearer ${{ secrets.RESTEP_TEST_TOKEN }}
```

Si la rama base está desplegada (por ejemplo en un entorno de preproducción),
`base-discovery` también admite una URL: la acción pide su descubrimiento. Las cabeceras de
`headers` solo se envían a esa URL si es del mismo origen que `url` (§4.3). Si la raíz no es un
descubrimiento y apunta a uno con `Link: rel="service-desc"`, la acción sigue el primer destino que
lo sea, pero no uno cuyo esquema no sea `https` ni el de la raíz (`data:`, `file:`, §3), y a uno de
otro origen no le manda las cabeceras.

## Inputs

| Input | Por defecto | Qué hace |
|---|---|---|
| `url` | (obligatorio) | Raíz de la API |
| `start-command` | | Orden que arranca la API en segundo plano (en `GITHUB_WORKSPACE`); su salida va a `$RUNNER_TEMP/restep-action/server.log` y se enseña si no arranca |
| `wait-for` | `url` | URL que debe responder (con cualquier estado HTTP) antes de seguir |
| `wait-timeout` | `60` | Segundos de espera máxima |
| `profiles` | | Perfiles y extensiones que la API debe anunciar, separados por comas o espacios |
| `writes` | `false` | `true` pasa `--writes` a restep-check (crea, cambia y borra sus propios elementos) |
| `headers` | | Cabeceras para todas las peticiones, una por línea. `Authorization` no sale en el registro |
| `base-discovery` | | Descubrimiento de la rama base: archivo (relativo a `GITHUB_WORKSPACE`) o URL |
| `comment` | `false` | `true` comenta en la PR (necesita `pull-requests: write`). Fuera de una PR solo escribe el resumen |
| `fail-on-error` | `true` | Falla el job si falla un DEBE, falta un perfil, hay un cambio incompatible o algo no se ha podido comprobar |
| `restep-check` | `npx --yes restep-check@0.9` | Orden que ejecuta restep-check (la 0.9 comprueba el borrador 6) |
| ~~~~ | | | que ejecuta restep-check |
| `restep-diff` | `npx --yes github:restep-spec/restep-diff#v0.2.0` | Orden que ejecuta restep-diff (0.2 clasifica según el borrador 6) |
| `github-token` | `github.token` | Token para `gh` |

## Salidas

| Salida | Valor |
|---|---|
| `result` | `pass` o `fail` |
| `check-failures` | Número de comprobaciones DEBE que fallan |
| `breaking` | `true` si restep-diff encuentra cambios incompatibles |
| `summary-file` | Ruta del informe en Markdown (el mismo que el resumen y el comentario) |

## Dependencia de restep-diff

`restep-diff` es otra herramienta de Restep ([restep-spec/restep-diff](https://github.com/restep-spec/restep-diff)).
La acción supone esta interfaz:

```
restep-diff <viejo.json> <nuevo.json> --markdown --fail-on breaking
```

- Salida estándar: el informe en Markdown, que la acción incluye tal cual.
- Código de salida: `0` sin cambios incompatibles, `1` con alguno, cualquier otro si no ha
  podido comparar (la acción lo trata como error y enseña su salida de error).

No está en npm: la orden por defecto lo instala desde su repositorio con una versión fija. Si su interfaz cambia, hay que cambiar
`diff()` en `action.mjs` y el doble de prueba de `test.mjs`.

## Pruebas

```bash
node tools/restep-action/test.mjs
```

Sin dependencias ni red. Valida `action.yml` con un analizador del subconjunto de YAML que
usa (y lo contrasta con el de Ruby si está instalado), revisa su estructura (inputs declarados
y usados, salidas que apuntan a pasos que existen, ningún `${{ }}` dentro de un `run`) y
ejecuta los pasos en local simulando el runner: las variables `GITHUB_*` y `RUNNER_TEMP`, los
`if:` de cada paso (`always()`, `success()`, comparaciones con inputs) y las salidas. Usa el
servidor de referencia en los puertos 8897-8899, el `restep-check` de `public/tools/` y dobles
de `gh` y `restep-diff`. Recorre: arranque, comprobación y diff sin cambios con comentario
nuevo; cambio incompatible, perfil que falta y `--writes` actualizando el mismo comentario;
API ya arrancada con oauth fuera de una PR; API que no arranca; `fail-on-error: false`; un
DEBE que falla; y una API de versión mayor 2 cuyo descubrimiento está tras un `service-desc`
(con otro `data:` delante que no se sigue y otro de otro origen que no recibe credenciales).
Lo que anuncia la referencia (perfiles y extensiones) se lee de su descubrimiento, no se escribe
en la prueba.

## Límites

- Solo `bash`: en runners Windows hace falta Git Bash (que traen los de GitHub).
- La API arrancada con `start-command` se para enviando `SIGTERM` a su grupo de procesos;
  si deja procesos hijos en otro grupo, los recoge el runner al acabar el job.
- El comentario se busca por un marcador con la URL de la API: dos ejecuciones de la acción
  con la misma `url` en el mismo PR comparten comentario.
- No se ha ejecutado en GitHub de verdad: la prueba simula el runner.
- El valor por defecto de `restep-check` (`restep-check@0.9`) necesita que la 0.9 esté publicada
  en npm; mientras no lo esté, pasa la orden en el input.
- El de `restep-diff` (`github:restep-spec/restep-diff#v0.2.0`, las reglas del borrador 6) usa la
  etiqueta `v0.2.0` de su repositorio.
- Para usarla con `uses: restep-spec/restep-action@v0` hay que publicarla en su propio
  repositorio (como el espejo de restep-check); mientras, se puede copiar la carpeta al
  repositorio y usarla con `uses: ./ruta/a/restep-action`.

## Borrador 6

La acción no es un cliente de la API: delega en restep-check (la conformidad) y restep-diff (la
compatibilidad). De los requisitos de clientes de §12.2 le tocan los de pedir el descubrimiento:
los cumple (objeto JSON con `restep` de tipo cadena, primer `service-desc` que sea descubrimiento,
esquemas de enlace de §3, credenciales solo al origen de §4.3). No usa ninguna parte experimental
ni escribe nada en la API. Si la versión declarada no es Restep 1, lo dice en el resumen; quien
falla la comprobación es restep-check (`discovery.version`).

## Dudas sobre la spec

- §5.5 dice qué cambios son incompatibles, pero no si una API debe publicar su descubrimiento
  anterior o cómo obtenerlo: la acción depende de que el repositorio lo guarde o de un entorno
  con la versión base desplegada.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-action>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
