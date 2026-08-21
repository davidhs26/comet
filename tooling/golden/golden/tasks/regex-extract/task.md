# Extracción con regex: log → CSV

En este workspace hay un `app.log` con líneas del formato:

```
2024-03-01T08:02:31Z INFO user=luis action=purchase duration_ms=210
```

Generá un archivo `purchases.csv` con **solo** las líneas que tienen `action=purchase`:

- Primera línea (header): `timestamp,user,duration_ms`
- Una fila por compra, en el orden en que aparecen en el log.
- Sin espacios extra; el archivo debe terminar con un salto de línea.
