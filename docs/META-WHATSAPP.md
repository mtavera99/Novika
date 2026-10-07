# Conectar NOVIKA a WhatsApp Cloud API

Guía de la pantalla en la que estás ahora: **Meta Developers → Bot Novika → Configuración de producción → Configurar webhooks**.

> **Nada de esto toca BIKERPRO.** App distinta, número distinto, WABA distinta, webhook distinto, token distinto, servicio distinto, disco distinto. Si en algún paso una pantalla te muestra algo de BIKERPRO, para y avísame.

---

## Lo que Meta te está pidiendo

Dos campos:

| Campo | Qué es | De dónde sale |
|---|---|---|
| **URL de devolución de llamada** | La dirección pública donde NOVIKA escucha | Del despliegue en Render. **Todavía no existe**: hay que desplegar primero. |
| **Token de verificación** | Una cadena secreta que tú inventas | La generas tú. No la da Meta ni la da el código. |

El webhook tiene que estar **publicado y respondiendo** antes de pulsar "Verificar y guardar". Meta hace una llamada real a esa URL en ese momento: si no hay nada escuchando, falla.

Por eso el orden es: **1) desplegar → 2) verificar en Meta**.

---

## Paso 1 · Genera el token de verificación

Es una cadena secreta cualquiera, de 32 caracteres o más. Sirve una sola vez, en el handshake.

```bash
openssl rand -hex 32
```

Si no tienes `openssl`, con Node sirve igual:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Si no tienes terminal a mano, pídemelo y te genero uno.

Reglas:

- **No lo escribas en el repositorio.** Este repositorio es público.
- No reutilices el de BIKERPRO. El arranque de NOVIKA se bloquea si lo detecta.
- Guárdalo donde guardes tus contraseñas: lo vas a pegar en dos sitios y tienen que coincidir exactamente.

---

## Paso 2 · Consigue la clave secreta de la app

En **Meta Developers → Bot Novika → Configuración de la app → Básica → Clave secreta de la app → Mostrar**.

Esta clave es con la que se comprueba que cada mensaje entrante viene de verdad de Meta. Sin ella, la URL del webhook es una API pública: cualquiera que la descubra puede inventarse un cliente y hacer que el bot responda.

NOVIKA arranca sin ella (para no bloquearte el paso de verificación), pero mientras falte, los mensajes entrantes se registran en el diario y **no se procesan**. `/health` te lo dice con `firma_activa: false`.

---

## Paso 3 · Despliega NOVIKA en Render

Render → **New** → **Blueprint** → apunta a `mtavera99/Novika`. El archivo `render.yaml` ya configura el servicio, el disco y las variables que no son secretas.

Render te pedirá los secretos. Rellena **solo estos dos** para empezar:

| Variable | Valor |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | el del paso 1 |
| `META_APP_SECRET` | el del paso 2 |

Las demás (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `PANEL_TOKEN`, `OWNER_WHATSAPP`) se pueden dejar vacías de momento; el servicio arranca igual y avisa en los logs de qué falta.

Comprobaciones antes de seguir:

| Ajuste | Valor correcto | Por qué |
|---|---|---|
| Plan | **Starter**, no Free | El Free duerme y despertar tarda ~50 s: el primer mensaje del cliente se pierde |
| Disk | montado en `/var/data` | Sin disco, cada despliegue borra el diario y la memoria de duplicados |
| `DATA_DIR` | `/var/data` | Tiene que apuntar al disco |
| Health check | `/health` | Para que Render sepa si el proceso vive |
| Nombre del servicio | **no** debe contener `bikerpro` | NOVIKA se niega a arrancar si lo detecta |

Cuando termine el despliegue, abre en el navegador:

```
https://<tu-servicio>.onrender.com/health
```

Tiene que devolver un JSON con `"marca": "novika"` y `"firma_activa": true`.

**Si eso responde, ya tienes la URL de devolución de llamada.**

---

## Paso 4 · Rellena los dos campos en Meta

```
URL de devolución de llamada:
https://<tu-servicio>.onrender.com/webhook

Token de verificación:
<el mismo valor exacto que pusiste en WHATSAPP_VERIFY_TOKEN en Render>
```

Detalles que hacen fallar este paso:

- La ruta es **`/webhook`**, en minúsculas, sin barra final.
- **`https://`**, no `http://`. Meta rechaza HTTP.
- El token tiene que ser idéntico: sin espacios delante ni detrás, sin comillas, sin salto de línea al final. Un espacio invisible pegado al copiar es la causa más común de "No se pudo validar la URL de devolución de llamada".
- Pega la URL de **tu** servicio de Render, no la de ningún otro proyecto.

Pulsa **Verificar y guardar**.

Lo que pasa por dentro: Meta llama a `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`. NOVIKA compara el token y, si coincide, devuelve el `hub.challenge` tal cual con un 200.

---

## Paso 5 · Suscribe los eventos

En la misma pantalla de Webhooks, en **Campos del webhook**, suscribe:

| Campo | Para qué |
|---|---|
| `messages` | **Imprescindible.** Los mensajes que te escriben los clientes. |
| `message_template_status_update` | Cuando Meta aprueba o rechaza una plantilla. |

El campo `messages` trae también los acuses de entrega (`sent`, `delivered`, `read`, `failed`). NOVIKA los procesa: un `failed` es la única forma de saber que Meta aceptó un mensaje con un 200 y después no lo entregó.

---

## Paso 6 · Completa las credenciales

Con el webhook verificado, vuelve a Render → Environment y añade:

| Variable | Dónde encontrarla en Meta |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → "Identificador de número de teléfono". **No es el número**, es un ID numérico largo. |
| `WHATSAPP_WABA_ID` | WhatsApp → API Setup → "Identificador de la cuenta de WhatsApp Business". |
| `WHATSAPP_TOKEN` | Token de acceso permanente (vía usuario del sistema en Business Manager). El token temporal de 24 h solo sirve para probar. |
| `PANEL_TOKEN` | Lo inventas tú, con `openssl rand -hex 32`. **Distinto** del de verificación. |
| `OWNER_WHATSAPP` | Tu número, formato internacional sin `+`. Ej: `57300...` |

`WHATSAPP_PHONE_NUMBER_ID` importa más de lo que parece: en cuanto está puesta, NOVIKA **descarta** todo evento que venga de otro número. Es el candado que impide que, si dos apps de Meta acaban apuntando a este webhook, NOVIKA le conteste a los clientes de BIKERPRO.

> **Los tres "números" que se confunden siempre:**
> - el **número del bot** → el que marca el cliente
> - el **ID del número** (`WHATSAPP_PHONE_NUMBER_ID`) → lo que pide la API
> - tu **número personal** (`OWNER_WHATSAPP`) → donde recibes los avisos
>
> Son tres valores distintos. Pegarlos cruzados cuesta horas de buscar el fallo donde no está.

---

## Paso 7 · Primer mensaje real

1. Escribe al número de NOVIKA desde tu teléfono.
2. Abre `https://<tu-servicio>.onrender.com/eventos?token=<PANEL_TOKEN>`.

Qué vas a ver, y qué significa:

| Lo que aparece | Qué pasó |
|---|---|
| `entrada_cruda` y después `mensaje` | Todo bien: el evento llegó, se guardó en disco y se procesó. |
| `sin_responder` | Esperado en esta fase: `RESPUESTA_AUTOMATICA=0`, el bot no le escribe a nadie todavía. |
| `rechazado_sin_app_secret` | Falta `META_APP_SECRET`. El evento está guardado pero sin procesar. |
| `firma_invalida` | Alguien llamó a la URL sin ser Meta, o `META_APP_SECRET` está mal copiado. |
| `evento_ajeno` | Llegó un evento de otro número. **Avísame**: hay dos apps apuntando al mismo webhook. |
| El diario vacío | Meta no está entregando. El problema está en la configuración de Meta, no en el bot: revisa la suscripción a `messages`. |

Esa última distinción —"no llegó" contra "llegó y fallamos"— es el diagnóstico que más tiempo ahorra, y es la razón de que el diario exista.

---

## Qué NO hace NOVIKA todavía

Para que no haya sorpresas:

- **No le responde a nadie.** `RESPUESTA_AUTOMATICA=0`.
- **No tiene productos.** El catálogo solo tiene la plantilla.
- **No cotiza, no toma pedidos, no guarda ventas.** Eso es la fase 2, y necesita que primero definamos productos, precios y políticas reales.

Nada de esto se inventa solo. Son decisiones tuyas, y hasta que me las des, el código las deja explícitamente pendientes.
