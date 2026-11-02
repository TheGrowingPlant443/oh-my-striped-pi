declare module "omsp-legacy-pi-modules" {
	/** Lazy host package namespace loaders retained for compiled legacy extensions. */
	export const BUNDLED_OMSP_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}
