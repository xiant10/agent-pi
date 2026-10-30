/** A typed key of a service in the container. */
export type Token<T> = { readonly id: symbol; readonly name: string; readonly __type?: T };

export function token<T>(name: string): Token<T> {
	return { id: Symbol(name), name };
}

export type Factory<T> = (container: Container) => T | Promise<T>;

/**
 * Inversion of control for the harness. Core services are bound as lazy factories; plugins rebind or decorate them in
 * `register()`, before anything is built, and bind their own services (a CRM client, a feature-flag reader) for other
 * plugins to `get()` in `setup()`. The last binding of a token wins; each service is built once, on first `get()`.
 */
export class Container {
	readonly #bindings = new Map<symbol, { readonly name: string; readonly factory: Factory<unknown> }>();
	readonly #instances = new Map<symbol, Promise<unknown>>();

	bind<T>(token: Token<T>, factory: Factory<T>): this {
		if (this.#instances.has(token.id)) throw new Error(`${token.name} is already built; bind it in register()`);
		this.#bindings.set(token.id, { name: token.name, factory });
		return this;
	}

	value<T>(token: Token<T>, value: T): this {
		return this.bind(token, () => value);
	}

	/** Wrap the current binding, such as an authenticator with a tenant check or storage with metrics. */
	decorate<T>(token: Token<T>, wrap: (inner: T, container: Container) => T | Promise<T>): this {
		const inner = this.#bindings.get(token.id);
		if (inner === undefined) throw new Error(`no binding for ${token.name} to decorate`);
		return this.bind(token, async (container) => wrap((await inner.factory(container)) as T, container));
	}

	has(token: Token<unknown>): boolean {
		return this.#bindings.has(token.id);
	}

	get<T>(token: Token<T>): Promise<T> {
		let instance = this.#instances.get(token.id);
		if (instance === undefined) {
			const binding = this.#bindings.get(token.id);
			if (binding === undefined) return Promise.reject(new Error(`no binding for ${token.name}`));
			instance = Promise.resolve().then(() => binding.factory(this));
			this.#instances.set(token.id, instance);
		}
		return instance as Promise<T>;
	}
}
