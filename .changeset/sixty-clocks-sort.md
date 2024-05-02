---
'@statelyai/agent': patch
---

`defineEvents` was removed. Use the `events` property in `createAgent({ … })` instead:

```ts
import { z } from 'zod';
import { createAgent } from '@statelyai/agent';

const agent = createAgent({
  model: 'gpt-4-1106-preview',
  events: {
    'agent.getWeather': z.object({
      location: z.string().describe('The location to get the weather for'),
    }),
    'agent.reportWeather': z.object({
      location: z
        .string()
        .describe('The location the weather is being reported for'),
      highF: z.number().describe('The high temperature today in Fahrenheit'),
      lowF: z.number().describe('The low temperature today in Fahrenheit'),
      summary: z.string().describe('A summary of the weather conditions'),
    }),
    'agent.doSomethingElse': z
      .object({})
      .describe(
        'Do something else, because the user did not provide a location'
      ),
  },
});
```
