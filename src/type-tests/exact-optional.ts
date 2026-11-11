// Compiled with `exactOptionalPropertyTypes` by tsconfig.exact-optional.json:
// consumers with the flag on must still get typed schemas.
import { z } from "zod";
import type { InferOutput, StandardSchemaV1 } from "../types";

const schema = z.object({ count: z.number() });
const accepted: StandardSchemaV1<{ count: number }> = schema;
const output: InferOutput<typeof accepted> = { count: 1 };
// @ts-expect-error output keeps its type
const wrong: InferOutput<typeof accepted> = { count: "1" };

const inferred: InferOutput<typeof schema> = { count: 1 };
// @ts-expect-error inference from the schema itself keeps the type
const wrongInferred: InferOutput<typeof schema> = { count: "1" };
const parsed = z.string().transform((value) => value.length);
const length: InferOutput<typeof parsed> = 3;
// @ts-expect-error a transform's output differs from its input
const notLength: InferOutput<typeof parsed> = "3";

export { output, wrong, inferred, wrongInferred, length, notLength };
