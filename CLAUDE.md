# Zeron — notas de build (fork privado davidhs26/zeron)

## Repos: no confundir

- **`davidhs26/zeron`** (privado) — este repo. Tiene el delta propio. **Es el que se buildea.**
- **`zeronsh/comet`** (público) — upstream. Comparte historia con este repo, pero es
  otro repo en GitHub y tiene su propio `main`. `comet` no fue renombrado a `zeron`:
  sigue existiendo con ese nombre. Un `git pull` desde un clon de comet trae el main
  del upstream, **no** el de este fork.

## Build para device (iPhone)

La config de firma **no está commiteada**: el `project.pbxproj` de este repo trae
`PRODUCT_BUNDLE_IDENTIFIER = sh.zeron.Zeron` y sin `DEVELOPMENT_TEAM`. Se pasa
siempre como override en la línea de comando, nunca editando el `pbxproj` — así el
árbol queda limpio y no hay conflictos al syncear con upstream.

```sh
cd /Users/david/Developer/zeron

xcodebuild -project apps/ios/Zeron.xcodeproj -scheme Zeron -configuration Debug \
  -destination "platform=iOS,id=00008150-00017C9026F8401C" \
  -derivedDataPath /tmp/zeron-ios-dd \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=A6D6U82QMJ \
  PRODUCT_BUNDLE_IDENTIFIER=com.davidsutton.Zeron \
  build
```

Instalar por cable:

```sh
xcrun devicectl device install app \
  --device 00008150-00017C9026F8401C \
  /tmp/zeron-ios-dd/Build/Products/Debug-iphoneos/Zeron.app
```

El UDID sale de `xcrun devicectl list devices` (hoy: iPhone 17, `00008150-00017C9026F8401C`).

### Por qué importa el bundle id

Usar siempre `com.davidsutton.Zeron`. Con cualquier otro (p. ej. el `sh.zeron.Zeron`
que trae el repo), iOS instala una **segunda** app en vez de reemplazar la existente,
y se pierde la continuidad de datos.

**Ojo con abrir el proyecto en Xcode y darle Run**: la GUI no aplica estos overrides,
así que compila con `sh.zeron.Zeron` y te instala la app duplicada. Para Run desde
Xcode hay que setear team y bundle id a mano en la UI (sin commitear el cambio).

### Firma

- Identidad: `Apple Development: David Sutton (84X3QJ9L96)`
- Perfil: wildcard `iOS Team Provisioning Profile: *` (`4846f9c2-…`), team `A6D6U82QMJ`,
  vence ago-2027, ya incluye el UDID del iPhone.
- `-allowProvisioningUpdates` deja que Xcode **renueve** el perfil automático si hace
  falta. No crea identidades nuevas.

## Deuda conocida

- `apps/ios/Zeron/App/AppConfig.swift` usa `NSLock.lock()/unlock()` en contextos
  asíncronos. Hoy es warning; **es error en Swift 6 language mode**. Va a romper
  cuando suban el language mode.
- `apps/ios/Zeron/Sync/` tiene 4 `await` redundantes (`ChatRoomClient.swift:364,438`,
  `RegistryClient.swift:157,239`). Cosmético.
