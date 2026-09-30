/**
 * A `direct:<name>` slug's leading name token doesn't always match the vendor value
 * `eval_model_families.vendor` stores for it (that column follows OpenRouter's vendor-id
 * convention even for models that bypass OpenRouter). This maps the token to that vendor id.
 */
const DIRECT_NAME_TO_VENDOR: Record<string, string> = {
  mistral: 'mistralai',
};

/**
 * Resolves an `eval_models.slug` (OpenRouter's `<vendor>/<model>`, or `direct:<name>` for a
 * non-OpenRouter integration — see the schema comment on `eval_models.slug`) to the vendor value
 * used in `eval_model_families.vendor`. Returns null when no vendor can be determined: a
 * `direct:` slug whose leading name token has no entry in `DIRECT_NAME_TO_VENDOR`, or a slug with
 * neither a `/` nor a `direct:` prefix.
 */
export function vendorForModelSlug(slug: string): string | null {
  if (slug.startsWith('direct:')) {
    const name = slug.slice('direct:'.length);
    const leadingToken = name.split('-')[0];
    return DIRECT_NAME_TO_VENDOR[leadingToken] ?? null;
  }
  const slashIndex = slug.indexOf('/');
  return slashIndex > 0 ? slug.slice(0, slashIndex) : null;
}
