// `pg` is only installed inside the auth container (docker/auth-Dockerfile
// does `npm install --no-save pg`), so it is not resolvable from the repo.
// Map the bare specifier to the recording stub instead of vendoring a fake
// node_modules/pg that a real `npm i pg` would then fight with.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  new URL('./pg-resolve-hook.mjs', import.meta.url),
  pathToFileURL('./')
);
