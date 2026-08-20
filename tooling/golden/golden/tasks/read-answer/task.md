# Leer y responder

En este workspace hay dos archivos:

- `config.json` — indica qué métrica calcular (campo `metric`).
- `sales.csv` — ventas con header `region,amount`.

Leé `config.json` para saber la métrica pedida y calculala a partir de `sales.csv`. Para la métrica `top_region_by_total_sales`: sumá `amount` por `region` y elegí la región con mayor total; en caso de empate, la primera en orden alfabético.

Escribí el resultado en `answer.txt` como una única línea con el formato exacto:

```
<region> <total>
```

(region y total separados por un espacio; el total es un entero, sin decimales).
