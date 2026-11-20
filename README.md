# ToneChanger (versión web)

Página para subir o bajar el tono de un MP3 o WAV entre −12 y +12 semitonos sin cambiar su duración. Esta versión no necesita servidor: todo el procesamiento ocurre en el navegador, así que se puede publicar gratis en GitHub Pages o Cloudflare.

Proyecto de Matemáticas Aplicadas · Arturo Rodríguez y Dylan Cardona

## Archivos

```
index.html            la página
css/style.css         el diseño
js/app.js             botones, reproductores, carga del archivo y descarga
js/dsp.js             el cambio de tono: STFT, vocoder de fase y remuestreo
js/pitch-worker.js    procesa cada canal en segundo plano (Web Worker)
```

## Qué cambió respecto a la versión en Python

En la versión Flask, el navegador enviaba el audio a `app.py` y librosa hacía el cambio de tono. Aquí ese mismo método está escrito en JavaScript en `js/dsp.js`:

1. **STFT:** ventanas de Hann de 2048 muestras con saltos de 512 y una FFT por ventana.
2. **Vocoder de fase:** estira el audio por 1/rate sin cambiar sus frecuencias, con rate = 2^(−n/12).
3. **STFT inversa:** reconstruye la señal estirada.
4. **Remuestreo** con un filtro sinc: devuelve el audio a su duración original, y eso multiplica todas las frecuencias por 2^(n/12).

Comparamos el resultado con `librosa.effects.pitch_shift` y da prácticamente lo mismo (correlación de 1,0). Una nota de 440 Hz pasa a 880 Hz con +12 y a 220 Hz con −12, y la duración no cambia.

El navegador decodifica el MP3 o WAV con la Web Audio API, que reemplaza a soundfile, pydub y FFmpeg. El resultado se guarda como WAV de 16 bits.

## Probarla en tu computador

Puedes abrir `index.html` con doble clic y funciona. En ese modo el navegador no deja usar Web Workers, así que la página puede quedarse quieta unos segundos mientras procesa.

Para probarla como quedará en internet, abre una terminal en esta carpeta y ejecuta:

```
python -m http.server 8000
```

Luego entra a http://localhost:8000.

## Publicarla gratis en GitHub Pages

1. Crea una cuenta en https://github.com (si no tienes).
2. Arriba a la derecha, pulsa **+ → New repository**.
   - Nombre: `tonechanger`
   - Marca **Public** (GitHub Pages es gratis solo en repositorios públicos).
   - Pulsa **Create repository**.
3. En la página del repositorio vacío, haz clic en **uploading an existing file**.
4. Arrastra **lo que hay dentro** de esta carpeta: `index.html`, la carpeta `css`, la carpeta `js` y `README.md`. No arrastres la carpeta `ToneChanger-web` completa, porque `index.html` tiene que quedar en la raíz del repositorio.
5. Abajo pulsa **Commit changes**.
6. Ve a **Settings → Pages**. En *Build and deployment* elige:
   - Source: **Deploy from a branch**
   - Branch: **main** y carpeta **/ (root)**

   Luego pulsa **Save**.
7. Espera uno o dos minutos y recarga esa página. Arriba aparece la dirección:

   **https://TU-USUARIO.github.io/tonechanger/**

Para actualizarla, vuelve a subir los archivos que cambies con **Add file → Upload files**. GitHub la publica sola de nuevo.

## Opción B: Cloudflare

1. Crea una cuenta en https://dash.cloudflare.com.
2. Ve a **Workers & Pages → Create** y elige la opción de **subir archivos** (upload assets / drag and drop).
3. Arrastra esta carpeta y despliega.

Te da una dirección gratis tipo `tonechanger.pages.dev` o `tonechanger.TU-CUENTA.workers.dev`. También puedes conectar el repositorio de GitHub para que se actualice solo.

## Ponerle un dominio propio (opcional)

- **Dominio gratis por un año:** el GitHub Student Developer Pack (https://education.github.com/pack) trae algunos con tu correo institucional, como un .tech, un .me con Namecheap y otras extensiones con Name.com.
- **Comprado:** Cloudflare Registrar los vende a precio de costo.

Para conectarlo a GitHub Pages:

1. En el repositorio ve a **Settings → Pages → Custom domain**, escribe tu dominio (por ejemplo `www.tonechanger.tech`) y guarda.
2. En el panel donde compraste el dominio, crea estos registros DNS:
   - `www` → **CNAME** → `TU-USUARIO.github.io`
   - Para el dominio sin www, cuatro registros **A**: `185.199.108.153`, `185.199.109.153`, `185.199.110.153` y `185.199.111.153`
3. Cuando GitHub verifique el dominio, activa **Enforce HTTPS**.

## Pruebas rápidas

| Requisito | Prueba | Resultado esperado |
|---|---|---|
| RF01 | Abrir la dirección | Carga sin registro |
| RF02 | Cargar un MP3 y un WAV | Muestra nombre, tamaño, duración y canales |
| RF03 / RF04 | ▶, ⏸ y ■ en el original | Suena, pausa y vuelve a 0:00 |
| RF05–RF08 | Elegir +12 y pulsar Aplicar | Barra de progreso; la vista previa suena una octava más aguda y dura lo mismo |
| RF09 | Restablecer | El control vuelve a 0 y se borra el resultado |
| RF10 | Descargar | Baja `nombre_tono+12.wav` |
| RF11 | Cargar otro archivo | Reemplaza el anterior |
| RF12 | Cargar un .txt o un MP3 dañado | Mensaje de error en rojo |
| RNF02 | Abrir desde el celular | Todo en una columna, sin desplazamiento horizontal |
