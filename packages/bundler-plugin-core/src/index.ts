import SentryCli from "@sentry/cli";
import fs from "fs";
import MagicString from "magic-string";
import { createUnplugin, UnpluginOptions } from "unplugin";
import { normalizeUserOptions, validateOptions } from "./options-mapping";
import { debugIdUploadPlugin } from "./plugins/debug-id-upload";
import { releaseManagementPlugin } from "./plugins/release-management";
import { telemetryPlugin } from "./plugins/telemetry";
import { getSentryCli } from "./sentry/cli";
import { createLogger } from "./sentry/logger";
import { createSentryInstance, allowedToSendTelemetry } from "./sentry/telemetry";
import { Options } from "./types";
import {
  determineReleaseName,
  generateGlobalInjectorCode,
  getDependencies,
  getPackageJson,
  parseMajorVersion,
  stringToUUID,
} from "./utils";

interface SentryUnpluginFactoryOptions {
  releaseInjectionPlugin: (injectionCode: string) => UnpluginOptions;
  debugIdInjectionPlugin: () => UnpluginOptions;
}

/**
 * The sentry bundler plugin concerns itself with two things:
 * - Release injection
 * - Sourcemaps upload
 *
 * Release injection:
 * Per default the sentry bundler plugin will inject a global `SENTRY_RELEASE` into each JavaScript/TypeScript module
 * that is part of the bundle. On a technical level this is done by appending an import (`import "sentry-release-injector;"`)
 * to all entrypoint files of the user code (see `transformInclude` and `transform` hooks). This import is then resolved
 * by the sentry plugin to a virtual module that sets the global variable (see `resolveId` and `load` hooks).
 * If a user wants to inject the release into a particular set of modules they can use the `releaseInjectionTargets` option.
 *
 * Source maps upload:
 *
 * The sentry bundler plugin will also take care of uploading source maps to Sentry. This
 * is all done in the `writeBundle` hook. In this hook the sentry plugin will execute the
 * release creation pipeline:
 *
 * 1. Create a new release
 * 2. Delete already uploaded artifacts for this release (if `cleanArtifacts` is enabled)
 * 3. Upload sourcemaps based on `include` and source-map-specific options
 * 4. Associate a range of commits with the release (if `setCommits` is specified)
 * 5. Finalize the release (unless `finalize` is disabled)
 * 6. Add deploy information to the release (if `deploy` is specified)
 *
 * This release creation pipeline relies on Sentry CLI to execute the different steps.
 */
export function sentryUnpluginFactory({
  releaseInjectionPlugin,
  debugIdInjectionPlugin,
}: SentryUnpluginFactoryOptions) {
  return createUnplugin<Options, true>((userOptions, unpluginMetaContext) => {
    const options = normalizeUserOptions(userOptions);

    const shouldSendTelemetry = allowedToSendTelemetry(options);
    const { sentryHub, sentryClient } = createSentryInstance(
      options,
      shouldSendTelemetry,
      unpluginMetaContext.framework
    );
    const pluginExecutionTransaction = sentryHub.startTransaction({
      name: "Sentry Bundler Plugin execution",
    });
    sentryHub.getScope().setSpan(pluginExecutionTransaction);

    const logger = createLogger({
      prefix: `[sentry-${unpluginMetaContext.framework}-plugin]`,
      silent: options.silent,
      debug: options.debug,
    });

    function handleRecoverableError(unknownError: unknown) {
      pluginExecutionTransaction.setStatus("internal_error");

      if (options.errorHandler) {
        if (unknownError instanceof Error) {
          options.errorHandler(unknownError);
        } else {
          options.errorHandler(new Error("An unknown error occured"));
        }
      } else {
        throw unknownError;
      }
    }

    if (!validateOptions(options, logger)) {
      handleRecoverableError(
        new Error("Options were not set correctly. See output above for more details.")
      );
    }

    const cli = getSentryCli(options, logger);

    const releaseName = options.release ?? determineReleaseName();
    if (!releaseName) {
      handleRecoverableError(
        new Error("Unable to determine a release name. Please set the `release` option.")
      );
    }

    if (process.cwd().match(/\\node_modules\\|\/node_modules\//)) {
      logger.warn(
        "Running Sentry plugin from within a `node_modules` folder. Some features may not work."
      );
    }

    const plugins: UnpluginOptions[] = [];

    plugins.push(
      telemetryPlugin({
        pluginExecutionTransaction,
        logger,
        shouldSendTelemetry,
        sentryClient,
      })
    );

    if (options.injectRelease && releaseName) {
      const injectionCode = generateGlobalInjectorCode({
        release: releaseName,
        injectBuildInformation: options._experiments.injectBuildInformation || false,
      });

      plugins.push(releaseInjectionPlugin(injectionCode));
    }

    if (options.sourcemaps?.assets) {
      plugins.push(debugIdInjectionPlugin());
    }

    if (releaseName) {
      plugins.push(
        releaseManagementPlugin({
          logger,
          cliInstance: cli,
          releaseName: releaseName,
          shouldCleanArtifacts: options.cleanArtifacts,
          shouldUploadSourceMaps: options.uploadSourceMaps,
          shouldFinalizeRelease: options.finalize,
          include: options.include,
          setCommitsOption: options.setCommits,
          deployOptions: options.deploy,
          dist: options.dist,
          handleRecoverableError: handleRecoverableError,
          sentryHub,
          sentryClient,
        })
      );
    }

    if (!unpluginMetaContext.watchMode && options.sourcemaps?.assets !== undefined) {
      plugins.push(
        debugIdUploadPlugin({
          assets: options.sourcemaps.assets,
          ignore: options.sourcemaps.ignore,
          dist: options.dist,
          releaseName: releaseName,
          logger: logger,
          cliInstance: cli,
          handleRecoverableError: handleRecoverableError,
          sentryHub,
          sentryClient,
        })
      );
    }

    return plugins;
  });
}

export function getBuildInformation() {
  const packageJson = getPackageJson();

  const { deps, depsVersions } = packageJson
    ? getDependencies(packageJson)
    : { deps: [], depsVersions: {} };

  return {
    deps,
    depsVersions,
    nodeVersion: parseMajorVersion(process.version),
  };
}

/**
 * Determines whether the Sentry CLI binary is in its expected location.
 * This function is useful since `@sentry/cli` installs the binary via a post-install
 * script and post-install scripts may not always run. E.g. with `npm i --ignore-scripts`.
 */
export function sentryCliBinaryExists(): boolean {
  return fs.existsSync(SentryCli.getPath());
}

export function createRollupReleaseInjectionHooks(injectionCode: string) {
  const virtualReleaseInjectionFileId = "\0sentry-release-injection-file";

  return {
    resolveId(id: string) {
      if (id === virtualReleaseInjectionFileId) {
        return {
          id: virtualReleaseInjectionFileId,
          external: false,
          moduleSideEffects: true,
        };
      } else {
        return null;
      }
    },

    load(id: string) {
      if (id === virtualReleaseInjectionFileId) {
        return injectionCode;
      } else {
        return null;
      }
    },

    transform(code: string, id: string) {
      if (id === virtualReleaseInjectionFileId) {
        return null;
      }

      if (id.match(/\\node_modules\\|\/node_modules\//)) {
        return null;
      }

      if (![".js", ".ts", ".jsx", ".tsx", ".mjs"].some((ending) => id.endsWith(ending))) {
        return null;
      }

      const ms = new MagicString(code);

      // Appending instead of prepending has less probability of mucking with user's source maps.
      // Luckily import statements get hoisted to the top anyways.
      ms.append(`\n\n;import "${virtualReleaseInjectionFileId}";`);

      return {
        code: ms.toString(),
        map: ms.generateMap(),
      };
    },
  };
}

export function createRollupDebugIdInjectionHooks() {
  return {
    renderChunk(code: string, chunk: { fileName: string }) {
      if (
        [".js", ".mjs", ".cjs"].some((ending) => chunk.fileName.endsWith(ending)) // chunks could be any file (html, md, ...)
      ) {
        const debugId = stringToUUID(code); // generate a deterministic debug ID
        const codeToInject = getDebugIdSnippet(debugId);

        const ms = new MagicString(code, { filename: chunk.fileName });

        // We need to be careful not to inject the snippet before any `"use strict";`s.
        // As an additional complication `"use strict";`s may come after any number of comments.
        const commentUseStrictRegex =
          // Note: CodeQL complains that this regex potentially has n^2 runtime. This likely won't affect realistic files.
          /^(?:\s*|\/\*(?:.|\r|\n)*\*\/|\/\/.*[\n\r])*(?:"[^"]*";|'[^']*';)?/;

        if (code.match(commentUseStrictRegex)?.[0]) {
          // Add injected code after any comments or "use strict" at the beginning of the bundle.
          ms.replace(commentUseStrictRegex, (match) => `${match}${codeToInject}`);
        } else {
          // ms.replace() doesn't work when there is an empty string match (which happens if
          // there is neither, a comment, nor a "use strict" at the top of the chunk) so we
          // need this special case here.
          ms.prepend(codeToInject);
        }

        return {
          code: ms.toString(),
          map: ms.generateMap({ file: chunk.fileName }),
        };
      } else {
        return null; // returning null means not modifying the chunk at all
      }
    },
  };
}

export function getDebugIdSnippet(debugId: string): string {
  return `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:{},n=(new Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${debugId}",e._sentryDebugIdIdentifier="sentry-dbid-${debugId}")}catch(e){}}();`;
}

export type { Options } from "./types";
