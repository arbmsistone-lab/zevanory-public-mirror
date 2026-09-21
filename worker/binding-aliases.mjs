export function normalizeEnv(env) {
  const source = env || {};
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (prop === "AI") return Reflect.get(target, "AI", receiver) ?? Reflect.get(target, "IA", receiver) ?? null;
      if (prop === "ASSETS") return Reflect.get(target, "ASSETS", receiver) ?? Reflect.get(target, "ATIVOS", receiver) ?? null;
      if (prop === "ZEA10_ENGINE") return Reflect.get(target, "ZEA10_ENGINE", receiver) ?? Reflect.get(target, "ZEA10_MOTOR", receiver) ?? null;
      if (prop === "ZEVANORY_PRIVATE_ARTIFACTS") return Reflect.get(target, "ZEVANORY_PRIVATE_ARTIFACTS", receiver) ?? Reflect.get(target, "ZEVANORY_ARTEFATOS_PRIVADOS", receiver) ?? null;
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (prop === "AI") return Reflect.has(target, "AI") || Reflect.has(target, "IA");
      if (prop === "ASSETS") return Reflect.has(target, "ASSETS") || Reflect.has(target, "ATIVOS");
      if (prop === "ZEA10_ENGINE") return Reflect.has(target, "ZEA10_ENGINE") || Reflect.has(target, "ZEA10_MOTOR");
      if (prop === "ZEVANORY_PRIVATE_ARTIFACTS") return Reflect.has(target, "ZEVANORY_PRIVATE_ARTIFACTS") || Reflect.has(target, "ZEVANORY_ARTEFATOS_PRIVADOS");
      return Reflect.has(target, prop);
    }
  });
}
