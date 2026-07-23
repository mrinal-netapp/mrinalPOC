/**
 * Execution languages
 * Stub implementation for pipeline editor
 */

export enum CodeLanguage {
  JavaScript = 'javascript',
  Python = 'python',
}

export function getLanguageDisplayName(language: CodeLanguage): string {
  switch (language) {
    case CodeLanguage.JavaScript:
      return 'JavaScript'
    case CodeLanguage.Python:
      return 'Python'
    default:
      return String(language)
  }
}

