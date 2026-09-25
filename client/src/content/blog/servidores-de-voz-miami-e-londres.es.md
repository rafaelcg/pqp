pqp ahora tiene servidores de voz en tres lugares: São Paulo, que sigue siendo la casa, Miami y Londres. Si estás lejos de Brasil, tu llamada habla con un servidor cerca de ti, y tu voz llega más rápido.

## Servidor cerca, menos retraso

Hasta esta semana, toda llamada que pasaba por un servidor iba a São Paulo, estuvieras donde estuvieras. Perfecto si juegas desde Brasil. Para todos los demás, cada frase hacía un viaje larguísimo hasta acá y de vuelta.

Ahora queda así:

- **Miami:** Estados Unidos, Canadá, México, Centroamérica, el Caribe, Colombia y Venezuela.
- **Londres:** Reino Unido, Irlanda, Europa occidental y del norte, Polonia, Chequia, Nigeria, Ghana y Kenia.
- **São Paulo:** Brasil y todo lo demás.

La diferencia se nota. Lo medimos hoy desde el Reino Unido: el servidor de Londres responde en unos 15 ms, y el de São Paulo en unos 190 ms. Y en una llamada de prueba entre el Reino Unido y São Paulo, la pérdida de paquetes fue cero en todos los servidores.

## Cómo funciona

No tienes que hacer nada. En las comunidades y en los servidores más grandes, la voz pasa por un servidor de pqp, y pqp elige el que queda más cerca de la gente de ese servidor. Todos en la llamada caen en el mismo, así que nadie se queda fuera de la conversación.

Las llamadas por DM y las de servidores pequeños ya los conectan directo, de uno a otro, sin ningún servidor en medio. Eso no cambió.

¿Quieres ver dónde corre pqp y si cada servidor está en línea ahora mismo? Hay un mapa nuevo en la página de inicio, en [pqp.gg/#where](https://pqp.gg/#where).

## Watch party

Las watch parties siguen saliendo de São Paulo y te llegan por la red de Cloudflare, cerca de donde estés viendo.

Y también mejoraron:

- El modo de baja latencia va más fluido. Cuando tu conexión se traba, el reproductor toma unos segundos de colchón en vez de congelarse, y después los devuelve cuando puede.
- En **Transmisiones anteriores** puedes volver a ver una función, y en **Descargar** está la cámara y la voz de quien la presentó. Una transmisión de baja latencia también deja el video completo, listo unos minutos después de que termina.
- Cada transmisión anterior muestra el pico de gente viendo al mismo tiempo y cuántas personas distintas pasaron.
- Una actualización de nuestro lado ya no tumba la watch party a mitad de la película.

## Lo demás

- pqp ya habla español. Elige **Español** en **Configuración**, **Apariencia e idioma**. Un navegador en español ya abre en español solito.
- Push-to-talk funciona en cualquier pantalla, incluso mientras escribes. En la app de escritorio (0.1.9) funciona con la ventana en segundo plano.

## Todavía no

- Las apps de iPhone y Android todavía no eligen región. Una llamada que empieza desde el celular abre en São Paulo. Entrar desde el celular a una llamada de Miami o Londres funciona normal.
