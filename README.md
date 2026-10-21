# Helpdesk TI — Inventario + Contraseñas por empresa

App web privada (con inicio de sesión) para administrar tus clientes:
inventario de equipos por empresa, contraseñas administrativas (correo,
routers, paneles, etc.) y exportación a Excel. Gratis: usa Supabase como
base de datos y GitHub Pages como hosting.

- **Técnicos** (rol `tecnico`): ven Empresas, Inventario y las Contraseñas
  de las empresas (correo administrativo, routers, etc.) — pueden agregar
  equipos y credenciales, pero no borrar ni crear/borrar empresas.
- **Administrador** (tú, rol `admin`): además puede crear/borrar empresas y
  borrar cualquier equipo o credencial.
- **Personal** (todos, técnicos y admin por igual): cada usuario tiene su
  propio apartado privado (ej. "SANTI PERSONAL") para sus propias
  contraseñas — correo personal, cuentas propias, etc. Nadie más lo ve, ni
  siquiera el administrador; queda protegido a nivel de base de datos, no
  solo escondido en la pantalla. Cada quien le pone el nombre que quiera a
  su apartado desde ahí mismo.

## Archivos

- `index.html` — login + la app (empresas, inventario, contraseñas). Los
  estilos van incluidos en este mismo archivo a propósito, para que se vea
  bien incluso si alguna vez lo abres suelto, sin los demás archivos.
- `app.js` — toda la lógica (conexión a Supabase, guardar/leer datos, exportar a Excel).
- `config.js` — aquí pegas tus llaves de Supabase.
- `schema.sql` — crea las tablas y la seguridad en Supabase (se corre una sola vez).

## Instalación (20-25 minutos, una sola vez)

### 1. Crear el proyecto en Supabase

1. Ve a [supabase.com](https://supabase.com) → **Start your project** → crea
   una cuenta gratis (puedes usar tu cuenta de GitHub o Google).
2. **New project** → ponle un nombre (ej. `helpdesk-ti`), elige una
   contraseña para la base de datos (guárdala, no la necesitarás en el día
   a día) y la región más cercana (ej. `South America`).
3. Espera 1-2 minutos mientras Supabase crea el proyecto.

### 2. Crear las tablas

1. En el menú izquierdo, entra a **SQL Editor** → **New query**.
2. Abre el archivo `schema.sql` de esta carpeta, copia **todo** el
   contenido y pégalo ahí.
3. Clic en **Run**. Deberías ver "Success. No rows returned".

### 3. Conectar la app a tu proyecto

1. En el menú izquierdo: **Project Settings** (ícono de engranaje) → **API**.
2. Copia el valor de **Project URL**.
3. Copia el valor de **anon public** (la llave larga que empieza con `eyJ...`).
4. Abre `config.js` y reemplaza:
   ```js
   const SUPABASE_URL = "PEGA_AQUI_TU_PROJECT_URL";
   const SUPABASE_ANON_KEY = "PEGA_AQUI_TU_ANON_KEY";
   ```
   con los valores que copiaste.

   Esta llave "anon" es segura de dejar en el código aunque el repositorio
   sea público — no da acceso a nada por sí sola, la protección real la dan
   las reglas de seguridad que ya quedaron activas con `schema.sql` (cada
   quien solo puede ver/editar lo que le corresponde según su rol).

### 4. Crear tu usuario (y los de tus colaboradores)

Esta app no tiene registro público — los usuarios los creas tú desde
Supabase. Supabase exige que cada cuenta tenga forma de correo (`algo@algo`),
pero para que tú y tus colaboradores solo tengan que escribir un nombre de
usuario simple (ej. `santiago.agudelo`) al entrar, la app le agrega por
detrás el dominio interno `@sag.local` (definido en `config.js` como
`USUARIO_DOMINIO` — puedes cambiarlo si quieres otro). Ese dominio no
recibe correos reales, es solo un formato.

1. Menú izquierdo → **Authentication** → **Users** → **Add user** → **Create new user**.
2. En "Email" pon `nombredeusuario@sag.local` (ej. `santiago.agudelo@sag.local`).
   En la app, esa persona solo escribe `santiago.agudelo`, sin el dominio.
3. Pon una contraseña de **al menos 6 caracteres** (Supabase la exige).
   Puede ser cualquiera para empezar — se cambia después desde el mismo
   panel (**Authentication → Users** → clic en el usuario → **Reset password**).
4. Deja marcado "Auto Confirm User" para que quede activa de inmediato.
5. Repite para cada colaborador que necesite entrar a registrar inventario
   (cada quien con su propio nombre de usuario).
6. **Para que tú tengas acceso a las contraseñas administrativas**: ve a
   **Table Editor** → tabla `usuarios_perfil` → busca la fila que
   corresponde a tu usuario (se crea automáticamente en cuanto inicias
   sesión la primera vez) → edita la columna `rol` y cámbiala de `tecnico`
   a `admin`. Los colaboradores se quedan en `tecnico` (no ven contraseñas).

Si alguna vez prefieres que alguien entre con su correo real en vez de un
nombre de usuario simple, también funciona: solo créalo en Supabase con su
correo real y esa persona lo escribe completo (con `@`) al iniciar sesión —
la app detecta si ya trae `@` y no le agrega nada.

### 5. Subir el código a GitHub y publicarlo

1. Sube estos archivos (`index.html`, `app.js`, `config.js`
   ya con tus llaves, `schema.sql`, este `README.md`) a tu repositorio
   `PROGRAMAINVENTARIOEMPRESAS` en GitHub (arrastra los archivos desde la
   página del repo con **Add file → Upload files**, o con Git si lo usas).
2. En el repo: **Settings → Pages**.
3. En "Build and deployment" → Source: **Deploy from a branch**. Branch:
   **main**, carpeta **/(root)**. Guarda.
4. Espera 1-2 minutos y GitHub te da un link tipo
   `https://zanetti10.github.io/PROGRAMAINVENTARIOEMPRESAS/`. Ese es el
   link de tu app — lo abres tú y tus colaboradores, cada quien inicia
   sesión con su propio usuario.

> Si el repositorio es público, cualquiera puede ver el **código**, pero
> nadie puede entrar a los **datos** sin una cuenta creada por ti (paso 4)
> gracias a la seguridad activada en `schema.sql`. Si prefieres que ni el
> código sea visible, en **Settings → General** puedes poner el
> repositorio como privado — GitHub Pages funciona igual con repos
> privados si tienes GitHub Pro, o puedes usar otro hosting gratis como
> Netlify/Vercel arrastrando la misma carpeta.

## Cómo agregar una empresa nueva

Inicia sesión como admin → pestaña **Empresas** → escribe el nombre →
**Agregar**. Aparece de inmediato en los selectores de Inventario y
Contraseñas.

## Cómo agregar un colaborador nuevo

Repite el paso 4 (Authentication → Users → Add user) con su correo. Queda
como `tecnico` automáticamente: puede ver empresas y registrar inventario,
pero no ve contraseñas.

## Exportar a Excel

Dentro de Inventario o Contraseñas, selecciona la empresa y da clic en
**Exportar a Excel** — descarga un `.xlsx` con todo lo registrado para esa
empresa (útil para una entrega o respaldo).

## Actualizar la app más adelante

Edita `index.html`, `app.js` o `style.css` y vuelve a subir los archivos
actualizados al mismo repositorio (reemplazando los anteriores) — GitHub
Pages se actualiza solo en 1-2 minutos.


## Seguridad, rendimiento y ficha para el cliente

El agente que se instala en los equipos (carpeta `agente/`) reporta, además
del inventario, el estado de protección y lo que afecta el rendimiento de
cada equipo. Con eso la app tiene:

- **Vista Seguridad**: semáforo de todos los equipos de todas las empresas
  (protegido / con advertencia / en riesgo / sin vigilancia), los equipos
  que necesitan atención, las amenazas detectadas y lo que el agente
  corrigió solo.
- **Acciones de antivirus** desde el detalle de un equipo: análisis rápido
  o completo, actualizar firmas, activar la protección, eliminar amenazas.
  Aplican a Microsoft Defender; si el equipo usa otro antivirus (ESET,
  etc.) la app muestra su estado pero no lo controla.
- **Respuesta automática** (se prende o apaga por empresa): cada 15 minutos
  el agente revisa que la protección siga en pie y, si la apagaron, las
  firmas tienen más de 3 días o quedó una amenaza sin resolver, lo corrige
  y lo deja anotado.
- **Ficha del equipo** e **Informe para el cliente**: hojas claras, para
  mostrar en pantalla o imprimir/guardar en PDF, con el esquema del equipo
  (procesador, ranuras de memoria, discos), lo que conviene mejorar y su
  estado de protección.

### Activarlo (una sola vez)

1. En Supabase → **SQL Editor**, correr `supabase/seguridad.sql`.
2. Publicar de nuevo las Edge Functions `agente-inventario` y
   `agente-comandos` (carpeta `supabase/functions/`), las dos con
   "Verify JWT" desactivado, igual que antes.
3. Subir los archivos al repositorio (GitHub Pages los publica solo).
4. En la vista **Seguridad**, botón **Actualizar agentes** de cada empresa:
   los equipos que ya tenían el agente descargan la versión nueva sin
   tener que ir hasta ellos. Los equipos nuevos ya la instalan directo.

El orden importa: primero el SQL, después las funciones.
