/**
 * Pre-bundle Temporal workflows for the evaluation worker.
 *
 * Runs during build via `nx bundle-workflows eval-worker` before webpack.
 * Writes workflow-bundle.js to tmp/workflow-bundles-eval/ where webpack
 * picks it up as a static asset and copies it to the dist output directory.
 *
 * Why pre-bundle? Temporal Workers need real filesystem paths to resolve
 * workflow modules. Webpack replaces require.resolve() with numeric IDs at
 * build time, breaking Temporal's runtime bundling. Pre-bundling avoids this.
 *
 * Why webpackConfigHook? Temporal's internal webpack does not read
 * tsconfig.base.json path aliases, so `@agent-studio/*` imports do not
 * resolve. We alias `@agent-studio/shared/evaluation` to `workflow-safe.ts`
 * (types + constants, NO trigger / NO node:crypto / NO @temporalio/client)
 * so the workflow bundle stays sandbox-compatible.
 */
import { bundleWorkflowCode } from '@temporalio/worker';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Configuration } from 'webpack';

async function bundle(): Promise<void> {
  console.log('Bundling evaluation workflows...');

  const workflowsPath = path.resolve(__dirname, '../src/workflows');
  const workerRoot = path.resolve(__dirname, '..');
  const outputDir = path.resolve(workerRoot, 'tmp/workflow-bundles-eval');
  const outputPath = path.join(outputDir, 'workflow-bundle.js');

  try {
    await mkdir(outputDir, { recursive: true });

    const { code } = await bundleWorkflowCode({
      workflowsPath,
      webpackConfigHook: (config: Configuration): Configuration => {
        config.resolve ??= {};
        config.resolve.alias = {
          ...(config.resolve.alias as Record<string, string>),
          // Redirect the local evaluation barrel to its sandbox-safe subset so
          // webpack does not pull trigger.ts (client SDK + node:crypto) into
          // the workflow bundle.
          //
          // Both keys use the `$` suffix so webpack treats them as exact-match
          // aliases; otherwise sub-paths like `evaluation/lib/audit-types`
          // would get rewritten with `workflow-safe.ts` as a path prefix.
          [path.resolve(workerRoot, 'src/lib/evaluation/index.ts') + '$']:
            path.resolve(workerRoot, 'src/lib/evaluation/workflow-safe.ts'),
          [path.resolve(workerRoot, 'src/lib/evaluation') + '$']:
            path.resolve(workerRoot, 'src/lib/evaluation/workflow-safe.ts'),
        };
        return config;
      },
    });

    await writeFile(outputPath, code);
    console.log(`Workflow bundle written to: ${outputPath}`);
    console.log(`Bundle size: ${(code.length / 1024).toFixed(2)} KB`);
  } catch (error) {
    console.error('Failed to bundle workflows:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  }
}

bundle();
