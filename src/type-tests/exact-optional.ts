// Compiled with `exactOptionalPropertyTypes` by tsconfig.exact-optional.json:
// consumers with the flag on must still get typed schemas.
import { z } from "zod";
import type { InferOutput, StandardSchemaV1 } from "../types";

const schema = z.object({ count: z.number() });
const accepted: StandardSchemaV1<{ count: number }> = schema;
const output: InferOutput<typeof accepted> = { count: 1 };
// @ts-expect-error output keeps its type
const wrong: InferOutput<typeof accepted> = { count: "1" };

export { output, wrong };
