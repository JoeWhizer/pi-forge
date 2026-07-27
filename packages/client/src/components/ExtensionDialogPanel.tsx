import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError, type AskUserQuestionAnswer } from "../lib/api-client";
import {
  useAskUserQuestionStore,
  type ExtensionDialogPresentation,
  type ForgeCustomDialogField,
  type PendingAskQuestion,
} from "../store/ask-user-question-store";

interface Props {
  pending: PendingAskQuestion & { presentation: ExtensionDialogPresentation };
}

type Values = Record<string, string | boolean>;

function initialValues(fields: ForgeCustomDialogField[]): Values {
  return Object.fromEntries(
    fields.map((field) => [
      field.id,
      field.defaultValue ?? (field.type === "checkbox" ? false : ""),
    ]),
  );
}

function fieldIsValid(field: ForgeCustomDialogField, value: string | boolean): boolean {
  if (field.type === "checkbox") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  return !(field.required === true && value.trim().length === 0);
}

/**
 * Browser-native extension dialogs. This intentionally renders only the
 * serialisable presentation schema emitted by the server; it never evaluates
 * terminal component factories supplied to ctx.ui.custom().
 */
export function ExtensionDialogPanel({ pending }: Props) {
  const clearPending = useAskUserQuestionStore((s) => s.clearPending);
  const presentation = pending.presentation;
  const [text, setText] = useState(
    presentation.kind === "extension_editor" ? (presentation.prefill ?? "") : "",
  );
  const [selection, setSelection] = useState("");
  const [values, setValues] = useState<Values>(() =>
    presentation.kind === "extension_custom" ? initialValues(presentation.schema.fields) : {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (presentation.kind === "extension_editor") editorRef.current?.focus();
  }, [presentation.kind]);

  const title =
    presentation.kind === "extension_custom" ? presentation.schema.title : presentation.title;
  const extension = presentation.extension;
  const question = pending.questions[0]?.question ?? title;
  const customFields = presentation.kind === "extension_custom" ? presentation.schema.fields : [];
  const canSubmit = useMemo(() => {
    if (presentation.kind === "extension_select") return selection.length > 0;
    if (presentation.kind === "extension_custom") {
      return customFields.every((field) => fieldIsValid(field, values[field.id] ?? ""));
    }
    return true;
  }, [customFields, presentation.kind, selection.length, values]);

  const answerForSubmission = (): AskUserQuestionAnswer => {
    if (presentation.kind === "extension_select") {
      return { questionIndex: 0, question, kind: "option", answer: selection };
    }
    if (presentation.kind === "extension_custom") {
      return { questionIndex: 0, question, kind: "custom", answer: JSON.stringify(values) };
    }
    return { questionIndex: 0, question, kind: "custom", answer: text };
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.submitAskUserQuestionAnswer(pending.sessionId, {
        requestId: pending.requestId,
        answers: [answerForSubmission()],
      });
      clearPending(pending.sessionId, pending.requestId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
      setSubmitting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      await api.cancelAskUserQuestion(pending.sessionId, pending.requestId);
      clearPending(pending.sessionId, pending.requestId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
      setSubmitting(false);
    }
  };

  const setField = (id: string, value: string | boolean): void => {
    setValues((current) => ({ ...current, [id]: value }));
  };
  const stringValue = (id: string): string => {
    const value = values[id];
    return typeof value === "string" ? value : "";
  };

  return (
    <section
      role="dialog"
      aria-modal={presentation.kind === "extension_editor" ? true : undefined}
      aria-labelledby={`extension-dialog-${pending.requestId}`}
      className="flex max-h-[60vh] shrink-0 flex-col overflow-auto border-t border-amber-700/50 bg-neutral-900/40 light:border-amber-400 light:bg-amber-50/60"
    >
      <header className="border-b border-neutral-800 px-4 py-2 light:border-neutral-200">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 light:text-amber-700">
          Extension dialog
        </span>
        {extension !== undefined && (
          <span className="ml-2 text-[10px] text-neutral-500">from {extension}</span>
        )}
      </header>
      {error !== undefined && (
        <div
          role="alert"
          className="border-b border-red-700/40 bg-red-900/20 px-4 py-2 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800"
        >
          {error}
        </div>
      )}
      <div className="space-y-3 px-4 py-3">
        <h2
          id={`extension-dialog-${pending.requestId}`}
          className="text-base font-medium text-neutral-100 light:text-neutral-900"
        >
          {title}
        </h2>
        {presentation.kind === "extension_select" && (
          <div className="space-y-1" role="radiogroup" aria-label={title}>
            {presentation.options.map((option) => (
              <label
                key={option}
                className="flex cursor-pointer items-center gap-2 rounded border border-neutral-800 px-2 py-1.5 text-xs text-neutral-200 light:border-neutral-300 light:text-neutral-800"
              >
                <input
                  type="radio"
                  name={pending.requestId}
                  value={option}
                  checked={selection === option}
                  onChange={() => setSelection(option)}
                />
                {option}
              </label>
            ))}
          </div>
        )}
        {presentation.kind === "extension_input" && (
          <label
            className="block text-xs text-neutral-200 light:text-neutral-800"
            htmlFor={`extension-input-${pending.requestId}`}
          >
            <span className="mb-1 block">{title}</span>
            <input
              id={`extension-input-${pending.requestId}`}
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={presentation.placeholder}
              maxLength={4000}
              className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 light:border-neutral-300 light:bg-white light:text-neutral-900"
            />
          </label>
        )}
        {presentation.kind === "extension_editor" && (
          <textarea
            ref={editorRef}
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, 12000))}
            rows={12}
            maxLength={12000}
            aria-label={title}
            className="min-h-48 w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 light:border-neutral-300 light:bg-white light:text-neutral-900"
          />
        )}
        {presentation.kind === "extension_custom" && (
          <>
            {presentation.schema.description !== undefined && (
              <p className="text-sm text-neutral-300 light:text-neutral-700">
                {presentation.schema.description}
              </p>
            )}
            {customFields.map((field) => (
              <label
                key={field.id}
                className="block text-xs text-neutral-200 light:text-neutral-800"
              >
                {field.type === "checkbox" ? (
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={values[field.id] === true}
                      onChange={(event) => setField(field.id, event.target.checked)}
                    />
                    {field.label}
                  </span>
                ) : (
                  <>
                    <span className="mb-1 block">
                      {field.label}
                      {field.required === true ? " *" : ""}
                    </span>
                    {field.type === "select" ? (
                      <select
                        value={stringValue(field.id)}
                        onChange={(event) => setField(field.id, event.target.value)}
                        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 light:border-neutral-300 light:bg-white light:text-neutral-900"
                      >
                        <option value="">Select…</option>
                        {field.options?.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : field.type === "textarea" ? (
                      <textarea
                        value={stringValue(field.id)}
                        onChange={(event) => setField(field.id, event.target.value)}
                        placeholder={field.placeholder}
                        maxLength={field.maxLength}
                        rows={5}
                        className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 light:border-neutral-300 light:bg-white light:text-neutral-900"
                      />
                    ) : (
                      <input
                        value={stringValue(field.id)}
                        onChange={(event) => setField(field.id, event.target.value)}
                        placeholder={field.placeholder}
                        maxLength={field.maxLength}
                        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 light:border-neutral-300 light:bg-white light:text-neutral-900"
                      />
                    )}
                  </>
                )}
              </label>
            ))}
          </>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-neutral-800 px-4 py-2 light:border-neutral-200">
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={submitting}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !canSubmit}
          className="flex items-center gap-1 rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {submitting && <Loader2 size={12} className="animate-spin" />}
          {presentation.kind === "extension_custom"
            ? (presentation.schema.submitLabel ?? "Submit")
            : "Submit"}
        </button>
      </footer>
    </section>
  );
}
