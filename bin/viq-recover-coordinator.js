#!/usr/bin/env node
import { runLocalCoordinatorRecovery } from '../src/local-coordinator-recovery.js';

try {
  await runLocalCoordinatorRecovery(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`viq-recover-coordinator: ${error?.code ?? error?.message ?? 'recovery_failed'}\n`);
  process.exitCode = error?.message === 'invalid_arguments' || error?.message === 'acknowledgement_required' || error?.message === 'duplicate_acknowledgement' ? 2 : 1;
}
