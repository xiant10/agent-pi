---
name: weather
description: Use when the user asks about current weather or a forecast for a place.
tools: [weather:*]
keywords: [weather, forecast, rain, temperature, 天气]
---

# Weather

1. Resolve the place. If it is ambiguous, ask which one.
2. Call the forecast tool for that place and the day the user means.
3. Answer with the condition and temperature first; mention rain or wind only when relevant.
