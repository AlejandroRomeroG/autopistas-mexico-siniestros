# Siniestros en autopistas de México

Piloto estático para explorar registros reales de siniestros de la red de cuota, con la identidad visual de [Alejandro Romero González](https://alejandroromerog.github.io/) y temas claro y oscuro. La idea de explorar conteos por tramo y horario parte de [Tingkart / Norway Charts](https://norway-charts.netlify.app/road_accident_map/public/); la interfaz y la lógica se implementaron para este proyecto.

**[Abrir el mapa](https://alejandroromerog.github.io/autopistas-mexico-siniestros/)**

Elige una autopista, agrupa por intervalos de 1, 2, 5, 10 o 20 km y mueve las dos manijas del reloj para filtrar por hora aproximada. Las semanas pueden seleccionarse por separado. Un intervalo como 22:00–06:00 incluye ambos lados de medianoche. La tabla y el CSV mantienen el mismo filtro del mapa.

## Datos reales y alcance

La [GeoPlataforma SICT / Instituto Mexicano del Transporte](https://rnc.imt.mx/geossi/) publica las capas semanales `accidentes30jun6jul2025datos` y `accidentes7_13jul2025datos`:

| Control del snapshot | Registros |
| --- | ---: |
| Publicados por las dos capas | 975 |
| Dentro de la semana anunciada | 965 |
| Ubicables a ≤1 km del trazo oficial asignado | 879 |
| Con ubicación y kilometraje interpretable para las barras | 878 |

El catálogo tiene 80 identidades normalizadas de carretera: 79 con geometría y 73 con registros ubicables. Incluye algunos puentes y libramientos identificados así por la fuente. La variante sin acento de Durango–Yerbanís comparte identidad con la variante acentuada. No se eliminan registros al normalizar nombres.

**El periodo cubierto es exclusivamente del 30 de junio al 13 de julio de 2025.** No representa todos los siniestros ni toda la red vial del país. Una ausencia de barras no acredita ausencia de accidentes o cobertura del registro.

### Fecha y hora

La codificación de fecha y hora se infiere de los valores publicados; no se encontró un diccionario de la capa que la confirme. Las fechas se interpretan como seriales Excel contemporáneos con origen `1899-12-30`. Se conservan y marcan las diez fechas fuera de la semana anunciada, sin reasignarlas.

La hora se interpreta como fracción de día: `(horaRaw % 1) * 24`. Los valores tienen dos decimales, un paso observado de 14.4 minutos. Las horas visibles y el filtro son **aproximados**, sin recuperación de minutos exactos ni conversión de zona horaria. Seis valores `1` se representan como medianoche aproximada con una advertencia, sin cambiar su fecha. El filtro incluye el inicio y excluye el final; extremos iguales significan todo el día.

### Geometría y barras

Las líneas proceden de la capa oficial `GEOSSI:red_vial_cuota_concesionario_geo`. Se conservan calzadas y ramales y se usan alias explícitos de nombres; no se crean conectores entre puntos de accidentes. La asociación errónea de concesión para México–Pachuca en la fuente se trata mediante el nombre de vía. Las coordenadas se redondean a seis decimales y sólo se deduplican líneas exactamente iguales dentro de una misma identidad de carretera.

Cada barra representa el número de registros por intervalo del **kilometraje reportado**, sumando ambos sentidos. Un registro representativo del intervalo permite asociarla con el corredor vial; no es una interpolación de postes kilométricos. Las barras se distribuyen sobre una **guía visual simplificada**, dibujada como una curva continua junto al trazo real, acompañada de curvas de escala. Esta guía se suaviza por distancia geográfica antes de proyectarse y mantiene el lado exterior y las orientaciones al cambiar el zoom; sus bases no son ubicaciones precisas de accidentes.

La guía parte de la geometría oficial conectada, sin unir tramos desconectados ni ordenar la vía ciegamente por los kilómetros reportados. Las calzadas paralelas comparten un eje gráfico cuando corresponden al mismo corredor. La separación del eje se adapta a la envolvente de la carretera, evitando que la banda cruce sus recodos. El ancho de cada barra parte del intervalo kilométrico reportado, con margen y ajustes para anclas incompatibles; no expresa longitud geográfica exacta. Los intervalos sin siniestros conservan sus huecos. La altura mantiene una escala lineal de conteos. Los ajustes de altura son comunes a todas las barras, conservando su proporción; la geometría y las escalas de referencia usan ambas semanas y todo el día y no cambian al filtrar horas o semana. La suma de las calzadas no se presenta como longitud de carretera.

Los puntos conservan las coordenadas originales. Los registros a más de 1 km del trazo o sin trazo se conservan en el JSON y la auditoría, pero no se dibujan. Un registro ubicable tiene `kmRaw=148+18`, no interpretable sin suponer una corrección: aparece como punto y queda fuera de las barras.

Los conteos son de **registros**, no de eventos únicos confirmados ni tasas de riesgo ajustadas por tránsito. Ocho grupos candidatos a duplicado se conservan por falta de una clave de evento documentada. Los valores originales y todas las advertencias son inspectables.

## Ejecutar y reproducir

El sitio no requiere servidor de aplicación, R, paquetes npm ni claves API.

```sh
npm test
npm run build
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

Para regenerar los artefactos desde los snapshots congelados, sin red:

```sh
python3 scripts/prepare-roads.py
python3 scripts/prepare-data.py
python3 scripts/pack-data.py
npm test
npm run build
```

`data/source/snapshot-manifest.json` registra las huellas SHA-256 de los archivos originales. La red vial se almacena comprimida con gzip. Los scripts usan sólo la biblioteca estándar de Python y rutas relativas al repositorio.

`prepare-data.py --download` solicita de nuevo las dos capas semanales explícitamente; no actualiza la geometría de forma automática. Una nueva descarga debe revisarse y volver a alinear con la geometría antes de publicar. La compilación habitual nunca refresca fuentes.

## Arquitectura y movimientos de mapa

HTML, CSS y módulos JavaScript locales. MapLibre GL JS 5.6.0 está incluido en `src/vendor/`, con su licencia; no se cargan scripts desde un CDN. El único servicio externo solicitado al navegar es el fondo cartográfico de Esri. Los registros y las geometrías se sirven desde el propio sitio, por lo que no dependen de CORS ni de la disponibilidad en vivo del WFS del IMT.

Se revisó [mapgl para R](https://walker-data.com/mapgl/): exporta htmlwidgets y ofrece `fly_to()`, `ease_to()` y `fit_bounds()`. Esas transiciones usan el mismo motor MapLibre. El piloto emplea directamente sus movimientos suaves (`fitBounds`, `easeTo`) y mantiene la cámara quieta al cambiar las horas. Se respeta `prefers-reduced-motion`. R/mapgl puede ser útil si el mantenimiento futuro se hace desde R o Quarto; no se añade una dependencia de R para este sitio estático.

El mapa permanece en vista plana, sin opción ni gestos de inclinación 3D. El reloj admite arrastre, teclado y selectores alternativos. Las etiquetas de carreteras tienen foco y tooltip. El CSV y una tabla paginada permiten inspeccionar los registros sin depender de los elementos del mapa.

## Publicación

GitHub Pages se configura desde `main`, carpeta `/docs`. `npm run build` genera esa carpeta desde `src/` y copia las fuentes congeladas. CI comprueba pruebas, sintaxis y consistencia del resultado compilado. No se usa OpenAI Sites. Las revisiones de este proyecto deben mantener GitHub Pages como destino.

## Créditos y licencias

- Accidentes y geometría: SICT / Instituto Mexicano del Transporte, GeoPlataforma y servicios públicos GeoSSI. Se conservan atribución, procedencia y datos originales; su disponibilidad pública no implica que este repositorio cambie los términos de la fuente.
- Fondo: Esri y los contribuidores indicados en la atribución visible del mapa, incluidos OpenStreetMap.
- MapLibre GL JS: BSD 3-Clause, licencia incluida en `src/vendor/MAPLIBRE-LICENSE.txt`.
- Inter Tight: SIL Open Font License 1.1, fuente y licencia incluidas en `src/vendor/`.
- Código propio del piloto: MIT. Las licencias del código no se aplican a los datos ni a los recursos de terceros.

## Identidad visual y temas

La composición actual toma la identidad del [sitio personal de Alejandro Romero González](https://alejandroromerog.github.io/), con referencias de TesisCIDE y Movilidad Integrada CDMX. Los controles principales y la leyenda están en un panel derecho; el periodo y el reloj permanecen visibles junto al mapa. Ofrece tema claro (crema/arena, acento lila profundo) y oscuro (carbón verdoso, texto crema, lila suave). La elección se guarda sólo para este proyecto; la primera visita sigue la preferencia del sistema. El fondo cartográfico cambia junto con la interfaz.

## Búsqueda de históricos adicionales

Se revisaron fuentes el 16 de octubre de 2026. La investigación no recuperó nuevos microdatos federales de autopistas con ubicación y hora que puedan incorporarse sin cambiar la población del piloto. El [registro de búsqueda](src/data/history-search.json) documenta fuentes, limitaciones y el extracto anonimizado que haría falta obtener.

El catálogo global del IMT sólo expone las dos semanas existentes y un alias. Los 15 recursos CAPUFE revisados son agregados. El histórico de Policía Federal tiene metadatos de 2015–2018 y evidencia académica de uso hasta 2019, pero su enlace original está caído y no se recuperó una copia utilizable. Siniestralimap Jalisco sí contiene datos de 2015–2025, pero son siniestros con víctimas en municipios metropolitanos, con ubicaciones por cruce y sin jurisdicción completa; se conserva como referencia para un alcance regional separado. No se añadieron personas como accidentes ni se generaron ubicaciones a partir de totales.
