// CI side: re-exports the evaluation core. The real evaluation runs inside the production
// Worker with its Workers AI binding (the CI token has no Workers AI permission: HTTP 401).
export { BATTERY, scoreAnswer, SUPPORT_EVAL_KEY } from "../../worker/support-eval.mjs";
