import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { schemaFields, type Json, type JsonObject, type SchemaField } from "@/lib/machine-ui";

type SchemaFormProps = {
  /** JSON Schema for the values object (an event payload or machine input). */
  schema: JsonObject;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel?: () => void;
};

function initialValue(field: SchemaField): string {
  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    return typeof field.defaultValue === "string"
      ? field.defaultValue
      : JSON.stringify(field.defaultValue);
  }
  if (field.kind.type === "enum") return field.kind.options[0] ?? "";
  if (field.kind.type === "boolean") return "false";
  return "";
}

function parseValue(field: SchemaField, raw: string): { value?: unknown; error?: string } {
  const trimmed = raw.trim();
  switch (field.kind.type) {
    case "string":
    case "enum":
      if (!trimmed && field.required) return { error: "Required" };
      return trimmed ? { value: raw } : {};
    case "number": {
      if (!trimmed) return field.required ? { error: "Required" } : {};
      const parsed = Number(trimmed);
      if (Number.isNaN(parsed)) return { error: "Not a number" };
      if (field.kind.integer && !Number.isInteger(parsed)) return { error: "Must be an integer" };
      return { value: parsed };
    }
    case "boolean":
      return { value: raw === "true" };
    case "json": {
      if (!trimmed) return field.required ? { error: "Required" } : {};
      try {
        return { value: JSON.parse(trimmed) as Json };
      } catch {
        return { error: "Invalid JSON" };
      }
    }
  }
}

/**
 * A form generated from a JSON Schema: flat object schemas become typed
 * fields (string / number / boolean / enum); anything deeper falls back to a
 * raw JSON field. Zod `.describe()` text shows as the field hint.
 */
export function SchemaForm({ schema, submitLabel, onSubmit, onCancel }: SchemaFormProps) {
  const fields = useMemo(() => schemaFields(schema), [schema]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((fields ?? []).map((field) => [field.name, initialValue(field)])),
  );
  const [rawJson, setRawJson] = useState("{}");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (fields === null) {
      try {
        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        onSubmit(parsed);
      } catch {
        setErrors({ __raw: "Invalid JSON" });
      }
      return;
    }
    const nextErrors: Record<string, string> = {};
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const { value, error } = parseValue(field, values[field.name] ?? "");
      if (error) nextErrors[field.name] = error;
      else if (value !== undefined) out[field.name] = value;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) onSubmit(out);
  };

  return (
    <form className="schema-form" onSubmit={submit}>
      {fields === null ? (
        <label className="schema-form__field">
          <span className="schema-form__label">Payload (JSON)</span>
          <textarea
            rows={5}
            value={rawJson}
            onChange={(event) => setRawJson(event.target.value)}
            spellCheck={false}
          />
          {errors.__raw ? <span className="schema-form__error">{errors.__raw}</span> : null}
        </label>
      ) : (
        fields.map((field) => (
          <label key={field.name} className="schema-form__field">
            <span className="schema-form__label">
              {field.label}
              {field.required ? <em aria-hidden="true"> *</em> : null}
            </span>
            {field.kind.type === "enum" ? (
              <select
                value={values[field.name]}
                onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}
              >
                {field.kind.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.kind.type === "boolean" ? (
              <span className="schema-form__checkbox">
                <input
                  type="checkbox"
                  checked={values[field.name] === "true"}
                  onChange={(event) =>
                    setValues((v) => ({
                      ...v,
                      [field.name]: event.target.checked ? "true" : "false",
                    }))
                  }
                />
                <span>{field.description ?? "Enabled"}</span>
              </span>
            ) : field.kind.type === "string" && field.kind.multiline ? (
              <textarea
                rows={3}
                value={values[field.name]}
                onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}
                placeholder={field.description ?? undefined}
              />
            ) : (
              <input
                type={field.kind.type === "number" ? "number" : "text"}
                value={values[field.name]}
                onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}
                placeholder={field.description ?? undefined}
              />
            )}
            {field.description && field.kind.type !== "boolean" ? (
              <span className="schema-form__hint">{field.description}</span>
            ) : null}
            {errors[field.name] ? (
              <span className="schema-form__error">{errors[field.name]}</span>
            ) : null}
          </label>
        ))
      )}
      <div className="schema-form__actions">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" size="sm">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
