/**
 * Normalizes a block name for comparison by converting to lowercase and removing spaces
 */
export function normalizeBlockName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

/**
 * Generates a unique block name by finding the highest number suffix among existing blocks
 */
export function getUniqueBlockName(baseName: string, existingBlocks: Record<string, any>): string {
  const normalizedBaseName = normalizeBlockName(baseName)
  if (normalizedBaseName === 'start' || normalizedBaseName === 'starter') {
    return 'Start'
  }

  const baseNameMatch = baseName.match(/^(.*?)(\s+\d+)?$/)
  const namePrefix = baseNameMatch ? baseNameMatch[1].trim() : baseName

  const normalizedBase = normalizeBlockName(namePrefix)

  const existingNumbers = Object.values(existingBlocks)
    .filter((block) => {
      const blockNameMatch = block.name?.match(/^(.*?)(\s+\d+)?$/)
      const blockPrefix = blockNameMatch ? blockNameMatch[1].trim() : block.name
      return blockPrefix && normalizeBlockName(blockPrefix) === normalizedBase
    })
    .map((block) => {
      const match = block.name?.match(/(\d+)$/)
      return match ? Number.parseInt(match[1], 10) : 0
    })

  const maxNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0

  if (maxNumber === 0 && existingNumbers.length === 0) {
    return `${namePrefix} 1`
  }

  return `${namePrefix} ${maxNumber + 1}`
}

