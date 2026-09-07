const STUB = new URL('./pg-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'pg') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
