/**
 * Base interface for deletion operators
 * Implements chain of responsibility pattern for resource cleanup
 */
export interface DeletionOperator {
  /**
   * Execute the deletion operation
   * @param context Deletion context containing resource information
   * @returns true if operation succeeded, false if it should be skipped
   */
  execute(context: DeletionContext): Promise<boolean>;

  /**
   * Set the next operator in the chain
   */
  setNext(operator: DeletionOperator): DeletionOperator;
}

/**
 * Context passed between deletion operators
 */
export interface DeletionContext {
  projectId: string;
  bucketName: string;
  storageClassName: string;
  pvcName: string;
  namespace: string;
  [key: string]: any; // Allow operators to add context
}

/**
 * Base class for deletion operators
 */
export abstract class BaseDeletionOperator implements DeletionOperator {
  protected nextOperator: DeletionOperator | null = null;

  abstract execute(context: DeletionContext): Promise<boolean>;

  setNext(operator: DeletionOperator): DeletionOperator {
    this.nextOperator = operator;
    return operator;
  }

  protected async executeNext(context: DeletionContext): Promise<void> {
    if (this.nextOperator) {
      await this.nextOperator.execute(context);
    }
  }
}

