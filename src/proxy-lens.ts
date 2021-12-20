import { BasicLens, prop } from "./basic-lens";
import { isObject } from "./is-object";
import { ShouldUpdate } from "./should-update";

type AnyObject = { [key: string | symbol | number]: JSON };
type AnyArray = JSON[];
type AnyPrimitive = number | bigint | string | boolean | null | void | symbol;
type JSON = AnyArray | AnyObject | AnyPrimitive;
type Proxyable = AnyArray | AnyObject;

type Updater<A> = (a: A) => A;
type Update<A> = (updater: Updater<A>) => void;
type Use<A> = (shouldUpdate?: ShouldUpdate<A>) => readonly [A, Update<A>];
type UseProxy<A> = (shouldUpdate?: ShouldUpdate<A>) => readonly [ProxyValue<A>, Update<A>];
type CreateUse<S> = <A>(lens: BasicLens<S, A>) => Use<A>;

type LensFixtures<S, A> = {
  lens: BasicLens<S, A>;
  createUse: CreateUse<S>;
};

type BaseProxyValue<A> = {
  toJSON(): A;
  toLens(): ProxyLens<A>;
};

type ArrayProxyValue<A extends AnyArray> = BaseProxyValue<A> & Array<ProxyValue<A[number]>>;
type ObjectProxyValue<A extends AnyObject> = BaseProxyValue<A> & { [K in keyof A]: ProxyValue<A[K]> };

// prettier-ignore
type ProxyValue<A> =
  A extends AnyArray ? ArrayProxyValue<A> :
  A extends AnyObject ? ObjectProxyValue<A> :
  A extends AnyPrimitive ? A :
  never;

type BaseProxyLens<A> = {
  /**
   * Collapses the `ProxyLens` into a `ProxyValue`.
   */
  use: UseProxy<A>;
  /**
   * A unique key for cases when you need a key. e.g. A React list.
   *
   * @example
   * const [list] = state.use();
   *
   * list.map(value => {
   *   const lens = value.toLens();
   *
   *   return <ListItem key={lens.$key} state={lens} />;
   * });
   */
  $key: string;
  /**
   * Internal. Only called by `ProxyValue#toLens`.
   */
  [TO_LENS](): ProxyLens<A>;
};

type ArrayProxyLens<A extends AnyArray> = BaseProxyLens<A> & { [K in number]: ProxyLens<A[K]> };
type ObjectProxyLens<A extends AnyObject> = BaseProxyLens<A> & { [K in keyof A]: ProxyLens<A[K]> };
type PrimitiveProxyLens<A extends AnyPrimitive> = BaseProxyLens<A>;

// prettier-ignore
export type ProxyLens<A> =
  A extends AnyArray ? ArrayProxyLens<A> :
  A extends AnyObject ? ObjectProxyLens<A> :
  A extends AnyPrimitive ? PrimitiveProxyLens<A> :
  never;

const PROXY_VALUE = Symbol();
const TO_LENS = Symbol();

let showCopyLensWarning = false;

let keyCounter = 0;
const proxyLensKey = () => `$$ProxyLens(${keyCounter++})`;

const isProxyable = (obj: any): obj is Proxyable => Array.isArray(obj) || isObject(obj);

const createUse = <S, A>(fixtures: LensFixtures<S, A>, lens: ProxyLens<A>): UseProxy<A> => {
  const use = fixtures.createUse(fixtures.lens);

  return (shouldUpdate) => {
    const [state, setState] = use(shouldUpdate);
    const next = proxyValue(state, lens);

    return [next, setState];
  };
};

const proxyValue = <A>(obj: A, lens: ProxyLens<A>): ProxyValue<A> => {
  if (!isProxyable(obj)) {
    return obj as ProxyValue<A>;
  }

  if (Reflect.has(obj, PROXY_VALUE)) {
    return Reflect.get(obj, PROXY_VALUE);
  }

  let toJSON: unknown;

  const proxy = new Proxy(obj, {
    get(target, key) {
      if (key === PROXY_VALUE) {
        return proxy;
      }

      if (key === "toJSON") {
        toJSON ??= () => target;
        return toJSON;
      }

      if (key === "toLens") {
        return lens[TO_LENS];
      }

      const nextValue = target[key as keyof A];
      const nextLens = (lens as any)[key];

      return proxyValue(nextValue, nextLens);
    },

    ownKeys(target) {
      return [...Reflect.ownKeys(target), "toLens", "toJSON"];
    },

    getOwnPropertyDescriptor(target, key) {
      if (key === PROXY_VALUE) {
        return {
          enumerable: false,
          value: proxy,
        };
      }

      return { configurable: true, enumerable: true, value: (proxy as any)[key] };
    },

    set() {
      throw new Error("Cannot set property on ProxyValue");
    },
    deleteProperty() {
      throw new Error("Cannot delete property on ProxyValue");
    },
  }) as ProxyValue<A>;

  /**
   * Do not allow `PROXY_VALUE` to be enumerable so that:
   *
   * 1. Creating a shallow copy `{ ...obj }` will ignore it. This ensures the
   *    proxy value is forgotten when the actual value changes.
   * 2. It is not accessible outside of this module.
   */
  Object.defineProperty(obj, PROXY_VALUE, {
    value: proxy,
    enumerable: false,
  });

  return proxy;
};

export const proxyLens = <S, A>(fixtures: LensFixtures<S, A>): ProxyLens<A> => {
  type LensCache = { [K in keyof A]?: ProxyLens<A[K]> };
  const cache: LensCache = {};

  let use: unknown;
  let toLens: unknown;
  let $key: unknown;

  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        /**
         * Block React introspection as it will otherwise produce an infinite chain of ProxyLens values.
         */
        // if (key === "$$typeof") {
        //   return undefined;
        // }

        if (key === "$key") {
          $key ??= proxyLensKey();
          return $key;
        }

        /**
         * This is attached to the proxy because the proxy never changes.
         * So even if the underlying data changes, the `ProxyValue` wrapping
         * it will always refer to the same `toLens` function.
         */
        if (key === TO_LENS) {
          toLens ??= () => proxy;
          return toLens;
        }

        if (key === "use") {
          use ??= createUse(fixtures, proxy);
          return use;
        }

        if (cache[key as keyof A] === undefined) {
          const nextFixtures = {
            ...fixtures,
            lens: prop(fixtures.lens, key as keyof A),
          };

          const nextProxy = proxyLens(nextFixtures);
          cache[key as keyof A] = nextProxy;
        }

        return cache[key as keyof A];
      },

      ownKeys(target) {
        return [...Object.keys(cache), "$key", "use", TO_LENS];
      },

      getOwnPropertyDescriptor(target, key) {
        if (key === "$key") {
          return {
            configurable: true,
            enumerable: true,
            value: proxy.$key,
          };
        }

        if (key === "use") {
          return {
            configurable: true,
            enumerable: true,
            value: proxy.use,
          };
        }

        if (key === TO_LENS) {
          return {
            configurable: true,
            enumerable: true,
            value: proxy[TO_LENS],
          };
        }

        if (key in cache) {
          if (!showCopyLensWarning) {
            showCopyLensWarning = true;

            console.warn(
              `"%c${String(key)}" as a key on ProxyLens is only available because it has been previously accessed. ` +
                "If you are iterating through keys of this object via `{ ...obj }` or `Object.assign({}, obj)`, please consider " +
                "an alternative approach.",
              "color: red; font-weight: bold;"
            );
          }

          return {
            configurable: true,
            enumerable: true,
            value: cache[key as keyof LensCache],
          };
        }
      },

      set() {
        throw new Error("Cannot set property on ProxyLens");
      },
      deleteProperty() {
        throw new Error("Cannot delete property on ProxyLens");
      },
    }
  ) as ProxyLens<A>;

  return proxy;
};
