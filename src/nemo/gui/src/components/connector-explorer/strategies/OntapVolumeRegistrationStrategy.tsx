import React from 'react'
import {
  Input,
  Text,
  Label,
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
  tokens,
} from '@fluentui/react-components'
import type { ExplorerNode } from '../../../services/api'
import { datasourceApi, CreateDataSourceRequest } from '../../../services/api'
import type { ExplorerActionStrategy, QueueItemBase, StrategyContext } from '../ExplorerActionStrategy'
import {
  bucketFormPrefillFromOntapVolume,
  validateOntapVolumeMountReady,
  nfsVersMountOptionsFromNode,
} from '../../../utils/ontapExplorerMount'

export interface OntapVolumeQueueItem extends QueueItemBase {
  name: string
  endpoint: string
  mountOptions: string[]
  protocol: string
  region: string
  metadata: string
  validationResult: { ok: boolean; blocking: string[]; warnings: string[] }
}

export class OntapVolumeRegistrationStrategy
  implements ExplorerActionStrategy<OntapVolumeQueueItem>
{
  actionLabel = 'Register Volumes'
  itemNoun = 'volume'
  selectableNodeTypes = ['volume']

  nodeToQueueItem(node: ExplorerNode, context: StrategyContext): OntapVolumeQueueItem {
    const clusterUrl = (context.clusterUrl as string) || ''
    const prefill = bucketFormPrefillFromOntapVolume(clusterUrl, node, {
      connectorId: context.connectorId,
    })
    const validation = validateOntapVolumeMountReady(node)

    return {
      id: node.id,
      nodeLabel: node.label,
      status: 'pending',
      name: prefill.name,
      endpoint: prefill.volumeEndpoint || '',
      mountOptions: nfsVersMountOptionsFromNode(node),
      protocol: 'NFS',
      region: 'Auto',
      metadata: prefill.metadata || '{}',
      validationResult: validation,
    }
  }

  validateItem(
    item: OntapVolumeQueueItem,
    allItems: OntapVolumeQueueItem[],
    existingNames?: Set<string>,
  ): string | null {
    if (!item.validationResult.ok) {
      return `NFS preflight failed: ${item.validationResult.blocking.join('; ') || 'volume cannot mount'}`
    }
    if (!item.name.trim()) {
      return 'Name is required'
    }
    if (!item.endpoint.trim()) {
      return 'NFS endpoint is required'
    }
    const dupes = allItems.filter((i) => i.id !== item.id && i.name.trim() === item.name.trim())
    if (dupes.length > 0) {
      return 'Duplicate name in queue'
    }
    if (existingNames?.has(item.name.trim())) {
      return 'Name already exists in project'
    }
    return null
  }

  renderItemFields(
    item: OntapVolumeQueueItem,
    onUpdate: (updates: Partial<OntapVolumeQueueItem>) => void,
    validationError: string | null,
  ): React.ReactNode {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div>
          <Label size="small">Name</Label>
          <Input
            size="small"
            value={item.name}
            onChange={(_, data) => onUpdate({ name: data.value })}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <Label size="small">NFS Endpoint</Label>
          <Input
            size="small"
            value={item.endpoint}
            onChange={(_, data) => onUpdate({ endpoint: data.value })}
            style={{ width: '100%' }}
          />
        </div>
        {validationError && (
          <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>
            {validationError}
          </Text>
        )}
        <Accordion collapsible>
          <AccordionItem value="advanced">
            <AccordionHeader size="small">
              <Text size={100}>Advanced</Text>
            </AccordionHeader>
            <AccordionPanel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' }}>
                <div>
                  <Label size="small">Mount Options</Label>
                  <Input
                    size="small"
                    value={item.mountOptions.join(',')}
                    onChange={(_, data) =>
                      onUpdate({ mountOptions: data.value.split(',').map((s) => s.trim()).filter(Boolean) })
                    }
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <Label size="small">Protocol</Label>
                  <Input size="small" value={item.protocol} readOnly style={{ width: '100%' }} />
                </div>
                <div>
                  <Label size="small">Region</Label>
                  <Input
                    size="small"
                    value={item.region}
                    onChange={(_, data) => onUpdate({ region: data.value })}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      </div>
    )
  }

  async applyItem(item: OntapVolumeQueueItem, context: StrategyContext): Promise<void> {
    let metaObj: Record<string, unknown> = {}
    try {
      metaObj = JSON.parse(item.metadata)
    } catch {
      /* keep empty */
    }

    const dsRequest: CreateDataSourceRequest = {
      name: item.name.trim(),
      type: 'volume',
      volume_config: {
        region: item.region,
        volume_info: {
          type: 'nfs',
          endpoint: item.endpoint.trim(),
          mount_options: item.mountOptions,
          provisioning_mode: 'static',
        },
        auth_info: { type: 'none' },
        protocol: item.protocol,
      },
      metadata: metaObj,
    }

    await datasourceApi.create(context.projectId, dsRequest)
  }
}
