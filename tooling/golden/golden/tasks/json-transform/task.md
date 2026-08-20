# Transformación de JSON

En este workspace hay un `data.json` con un array de personas: `[{"name","age","city"}, ...]`.

Generá un archivo `output.json` con exactamente estas dos claves:

- `"adults"`: array con los `name` de las personas con `age >= 18`, ordenados alfabéticamente.
- `"byCity"`: objeto que mapea cada `city` a la cantidad de personas que viven ahí.

Forma del resultado: `{"adults":[...],"byCity":{...}}`. No incluyas otras claves.
