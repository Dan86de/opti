/**
 * The in-worker TypeScript compiler: package sources in, diagnostics or
 * emitted JavaScript out.
 *
 * This is the written-down risk from the spec paying its bill: type checking
 * at publish requires the compiler to run inside a Worker. It runs on
 * `in-worker-typescript` - typescript 5.9 under an alias, because the
 * repository's own toolchain is the native TS7 line, which ships no
 * JavaScript compiler API - over a virtual file system: the package's
 * sources, generated declaration files for `opti:capabilities` and every
 * published package, the conformance check, and the embedded lib chain from
 * `libs.generated.ts`.
 *
 * Both heavyweight imports are dynamic on purpose. The compiler and the libs
 * together are ten megabytes of source, and a Worker pays for module-scope
 * initialization at cold start on every request; only a publish should pay
 * for the compiler.
 */
import type TS from "in-worker-typescript";

export interface CompileInput {
  /** Package-relative source path to content, the check file included. */
  readonly files: Readonly<Record<string, string>>;
  /** Absolute virtual paths to generated declaration files. */
  readonly ambient: Readonly<Record<string, string>>;
}

export type CompileResult =
  | { readonly ok: true; readonly emitted: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

/** What the sandbox runtime actually is: workerd's ES2023-era runtime with
 * the worker global surface, so `fetch` and `Response` type-check. */
const LIB_ROOTS = ["lib.es2023.d.ts", "lib.webworker.d.ts"];

const DIAGNOSTIC_BOUND = 5;

const PKG_DIR = "/pkg/";
const OUT_DIR = "/out";
const LIB_DIR = "/libs";

/** typescript 5.9 is a CommonJS module; what dynamic import hands back
 * differs by bundler, so take the default export when there is one. */
const loadCompiler = async (): Promise<typeof TS> => {
  const loaded: { readonly default?: typeof TS } & typeof TS = await import("in-worker-typescript");
  return loaded.default ?? loaded;
};

export const compile = async (input: CompileInput): Promise<CompileResult> => {
  const [ts, { LIB_FILES }] = await Promise.all([loadCompiler(), import("./libs.generated.ts")]);

  const virtual = new Map<string, string>();
  for (const [path, content] of Object.entries(input.files)) {
    virtual.set(`${PKG_DIR}${path}`, content);
  }
  for (const [path, content] of Object.entries(input.ambient)) {
    virtual.set(path, content);
  }
  for (const [name, content] of Object.entries(LIB_FILES)) {
    virtual.set(`${LIB_DIR}/${name}`, content);
  }

  const options: TS.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: LIB_ROOTS,
    strict: true,
    // The libs are pinned and self-consistent; checking a megabyte of them
    // on every publish would be pure cost.
    skipLibCheck: true,
    // Create-from-run freezes JavaScript verbatim, so a package may mix
    // languages; the JavaScript passes through emit unchecked.
    allowJs: true,
    baseUrl: "/",
    paths: {
      "opti:capabilities": ["/types/opti-capabilities.d.ts"],
      "opti:packages/*": ["/types/packages/*.d.ts"],
    },
    // Pinned so emit paths mirror source paths exactly: without it, tsc
    // emits relative to the computed common source directory, and a package
    // whose files share a subdirectory would silently lose it.
    rootDir: PKG_DIR,
    outDir: OUT_DIR,
    types: [],
  };

  const emitted: Record<string, string> = {};
  const outPrefix = `${OUT_DIR}/`;

  const host: TS.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const content = virtual.get(fileName);
      return content === undefined ? undefined : ts.createSourceFile(fileName, content, languageVersion, true);
    },
    getDefaultLibFileName: () => `${LIB_DIR}/${LIB_ROOTS[0]}`,
    getDefaultLibLocation: () => LIB_DIR,
    writeFile: (fileName, text) => {
      if (fileName.startsWith(outPrefix)) {
        emitted[fileName.slice(outPrefix.length)] = text;
      }
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => virtual.has(fileName),
    readFile: (fileName) => virtual.get(fileName),
  };

  // Package files live at nested module names inside the map, and workerd
  // resolves specifiers as paths against the referrer - so a bare
  // `opti:capabilities` inside a package would resolve under the package's
  // own directory. The emit rewrites every `opti:` specifier to its
  // `/`-prefixed absolute form, which resolves from any depth.
  const rewriteOptiSpecifiers: TS.TransformerFactory<TS.SourceFile> = (context) => {
    const { factory } = context;
    const rewrite = <Node extends TS.Node>(node: Node): TS.Node => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith("opti:")
      ) {
        const specifier = factory.createStringLiteral(`/${node.moduleSpecifier.text}`);
        return ts.isImportDeclaration(node)
          ? factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier, node.attributes)
          : factory.updateExportDeclaration(
              node,
              node.modifiers,
              node.isTypeOnly,
              node.exportClause,
              specifier,
              node.attributes,
            );
      }
      const first = ts.isCallExpression(node) ? node.arguments[0] : undefined;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        first !== undefined &&
        ts.isStringLiteral(first) &&
        first.text.startsWith("opti:")
      ) {
        return factory.updateCallExpression(node, node.expression, node.typeArguments, [
          factory.createStringLiteral(`/${first.text}`),
          ...node.arguments.slice(1),
        ]);
      }
      return ts.visitEachChild(node, rewrite, context);
    };
    return (source) => ts.visitNode(source, rewrite, ts.isSourceFile);
  };

  const rootNames = Object.keys(input.files).map((path) => `${PKG_DIR}${path}`);
  const program = ts.createProgram(rootNames, options, host);
  const emitResult = program.emit(undefined, undefined, undefined, false, { after: [rewriteOptiSpecifiers] });
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (diagnostics.length > 0) {
    const shown = diagnostics.slice(0, DIAGNOSTIC_BOUND).map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        return message;
      }
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const where = diagnostic.file.fileName.startsWith(PKG_DIR)
        ? diagnostic.file.fileName.slice(PKG_DIR.length)
        : diagnostic.file.fileName;
      return `${where}:${line + 1}: ${message}`;
    });
    return {
      ok: false,
      diagnostics:
        diagnostics.length > shown.length ? [...shown, `and ${diagnostics.length - shown.length} more`] : shown,
    };
  }

  return { ok: true, emitted };
};
