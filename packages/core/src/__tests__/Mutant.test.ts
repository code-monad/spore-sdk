import { describe, expect, it } from 'vitest';
import { bufferToRawString, bytifyRawString } from '../helpers';
import {
  createCluster,
  createMutant,
  createSpore,
  getClusterByOutPoint,
  getMutantById,
  getMutantByOutPoint,
  getSporeByOutPoint,
  meltSpore,
  transferMutant,
  transferSpore,
} from '../api';
import {
  OutPointRecord,
  expectCellLock,
  fetchLocalFile,
  getSporeOutput,
  popRecord,
  retryQuery,
  signAndSendTransaction,
} from './helpers';
import { CLUSTER_OUTPOINT_RECORDS, SPORE_OUTPOINT_RECORDS, TEST_ACCOUNTS, TEST_ENV } from './shared';
import { BI } from '@ckb-lumos/bi';
import { unpackToRawMutantArgs } from '../codec';

describe('Mutant', function () {
  const { rpc, config } = TEST_ENV;
  const { CHARLIE, ALICE } = TEST_ACCOUNTS;
  let existingMutantRecord: OutPointRecord | undefined;

  it('Create a Mutant', async function () {
    /**
     * [#1] Immortal Mutant can apply rules to the Spore:
     * - Spore with this Mutant applied cannot be melted from the blockchain
     * - Function exactly like the internal immortal feature, but throws a different error code
     * - Check logic: if (spore_ext_mode == 3) throw error(86)
     */
    const code = await fetchLocalFile('./resources/immortalMutant.lua', __dirname);
    /**
     * [#2] No Transfer Mutant can apply rules to make the Spore:
     * - Spore with this Mutant applied, cannot be transferred.
     * - Check logic: if (spore_ext_mode == 2) throw error(88)
     */
    // const code = await fetchLocalFile('./resources/noTransferMutant.lua', __dirname);
    /**
     * [#3] Must Transfer Mutant can apply rules to make the Spore:
     * - Spore with this Mutant applied, when transferring, cannot be transferred to the original owner
     * - Check logic: if (spore_ext_mode == 2 and spore_input_lock_hash == spore_output_lock_hash) throw error(87)
     */
    // const code = await fetchLocalFile('./resources/mustTransferMutant.lua', __dirname);
    /**
     * [#4] Second Output Mutant can apply rules to the Spore:
     * - Spore with this Mutant applied, the output's index must be zero (0x0)
     * - Check logic: if (spore_output_index > 0) throw error(89)
     */
    // const code = await fetchLocalFile('./resources/firstOutputMutant.lua', __dirname);

    const { txSkeleton, outputIndex } = await createMutant({
      data: code.bytes,
      minPayment: 1000,
      toLock: ALICE.lock,
      fromInfos: [ALICE.address],
      config,
    });

    // Sign and send transaction
    const hash = await signAndSendTransaction({
      account: ALICE,
      txSkeleton,
      config,
      rpc,
      send: true,
    });
    if (hash) {
      existingMutantRecord = {
        outPoint: {
          txHash: hash,
          index: BI.from(outputIndex).toHexString(),
        },
        account: ALICE,
      };
    }
  }, 30000);

  it('Transfer a Mutant', async function () {
    expect(existingMutantRecord).toBeDefined();
    const mutantRecord = existingMutantRecord!;
    const mutantCell = await retryQuery(() => getMutantByOutPoint(mutantRecord!.outPoint, config));

    const { txSkeleton, outputIndex } = await transferMutant({
      outPoint: mutantCell.outPoint!,
      minPayment: 1000,
      toLock: CHARLIE.lock,
      config,
    });

    // Sign and send transaction
    const hash = await signAndSendTransaction({
      account: ALICE,
      txSkeleton,
      config,
      rpc,
      send: true,
    });
    if (hash) {
      existingMutantRecord = {
        outPoint: {
          txHash: hash,
          index: BI.from(outputIndex).toHexString(),
        },
        account: CHARLIE,
      };
    }
  }, 30000);

  describe('Spore with Mutant', () => {
    it('Create a Spore with Mutant', async () => {
      expect(existingMutantRecord).toBeDefined();
      const mutantRecord = existingMutantRecord!;
      const mutantCell = await retryQuery(() => getMutantByOutPoint(mutantRecord!.outPoint, config));
      const mutantArgs = unpackToRawMutantArgs(mutantCell.cellOutput.type!.args);
      const mutantId = mutantArgs.id;
      console.log('mutant id:', mutantId);
      console.log('mutant payment:', mutantArgs.minPayment ?? 0);

      const { txSkeleton, outputIndex, reference, mutantReference } = await createSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('content'),
          contentTypeParameters: {
            mutant: [mutantId],
          },
        },
        fromInfos: [ALICE.address],
        toLock: ALICE.lock,
        config,
      });

      const spore = getSporeOutput(txSkeleton, outputIndex, config);
      expect(spore.data.contentType).toEqual(`text/plain;mutant[]=${mutantId.slice(2)}`);

      expect(reference).toBeDefined();
      expect(reference.referenceTarget).toEqual('none');

      expect(mutantReference).toBeDefined();
      if (mutantArgs.minPayment !== void 0) {
        expect(mutantReference!.referenceType).toEqual('payment');
        expect(mutantReference!.payment).toBeDefined();
        expect(mutantReference!.payment!.outputIndices.length).toEqual(1);
        const paymentCell = txSkeleton.get('outputs').get(mutantReference!.payment!.outputIndices[0]);
        expect(BI.from(paymentCell!.cellOutput.capacity).gte(BI.from(mutantArgs.minPayment))).toEqual(true);
        expect(paymentCell!.cellOutput.lock).toEqual(mutantCell.cellOutput.lock);
      } else {
        expect(mutantReference!.referenceType).toEqual('none');
      }

      const hash = await signAndSendTransaction({
        account: ALICE,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
      if (hash) {
        SPORE_OUTPOINT_RECORDS.push({
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: ALICE,
        });
      }
    }, 0);

    it.skipIf(CLUSTER_OUTPOINT_RECORDS.length > 0)(
      'Create a Cluster (if necessary)',
      async ({ skip }) => {
        if (CLUSTER_OUTPOINT_RECORDS.length > 0) {
          console.log('skipping test');
          return skip();
        }

        const { txSkeleton, outputIndex } = await createCluster({
          data: {
            name: 'Testnet Spores',
            description: 'Testing only',
          },
          fromInfos: [ALICE.address],
          toLock: ALICE.lock,
          config,
        });
        const hash = await signAndSendTransaction({
          account: ALICE,
          txSkeleton,
          config,
          rpc,
          send: true,
        });
        if (hash) {
          CLUSTER_OUTPOINT_RECORDS.push({
            outPoint: {
              txHash: hash,
              index: BI.from(outputIndex).toHexString(),
            },
            account: ALICE,
          });
        }
      },
      0,
    );

    it('Create a Spore with Mutant required Cluster', async () => {
      const clusterRecord = popRecord(CLUSTER_OUTPOINT_RECORDS, true);
      const clusterCell = await retryQuery(() => getClusterByOutPoint(clusterRecord.outPoint, config));
      const clusterId = clusterCell.cellOutput.type!.args;

      expect(existingMutantRecord).toBeDefined();
      const mutantRecord = existingMutantRecord!;
      const mutantCell = await retryQuery(() => getMutantByOutPoint(mutantRecord!.outPoint, config));
      const mutantArgs = unpackToRawMutantArgs(mutantCell.cellOutput.type!.args);
      const mutantId = mutantArgs.id;

      const {
        txSkeleton,
        outputIndex: _,
        reference,
        mutantReference,
      } = await createSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('content'),
          clusterId,
          contentTypeParameters: {
            mutant: [mutantId],
          },
        },
        fromInfos: [CHARLIE.address],
        toLock: CHARLIE.lock,
        config,
      });

      console.log('Spore Reference:', reference);
      console.log('Spore MutantReference:', mutantReference);

      await signAndSendTransaction({
        account: CHARLIE,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
    }, 0);
  });
});
