import type { ReactElement } from 'react';
import { IconInfoCircle } from '@tabler/icons-react';

import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { InputField } from '@/ui-lib/base-components/form/form-field.input';
import { Typography } from '@/ui-lib/base-components/typography/typography';

const TEXT_COLUMNS_REQUIRED_MESSAGE = 'Text columns are required for structured datasets';

interface KBTextColumnsFieldProps {
  form: AnyReactFormApi;
}

function textColumnsRequiredValidator({ value }: { value: string }): string | undefined {
  return value.trim() ? undefined : TEXT_COLUMNS_REQUIRED_MESSAGE;
}

/**
 * Shown only when the dataset backing this knowledge base is `kind=structured`
 * (tabular data). Structured datasets have no file contents to extract text
 * from automatically, so the user must specify which columns hold the text
 * to index — required by kb-processor (`TEXT_COLUMNS is required for
 * structured datasets`).
 */
function KBTextColumnsField({ form }: KBTextColumnsFieldProps): ReactElement {
  return (
    <>
      <div className="dset-form__sync-notice">
        <IconInfoCircle size={20} stroke={1.5} className="kb-text-columns__info-icon" aria-hidden />
        <Typography Component="p" fontSize="fs14" boldness="regular">
          This dataset contains tabular data. Specify which columns to use for text extraction.
        </Typography>
      </div>

      <div className="dset-form__field">
        <InputField
          form={form}
          name="text_columns"
          label="Text columns"
          placeholder="e.g., title, content, description"
          description='Comma-separated list of column names that contain text to index for semantic search. Each row is combined as "column_name: value" pairs.'
          validators={{
            onBlur: textColumnsRequiredValidator,
            onSubmit: textColumnsRequiredValidator,
          }}
        />
      </div>
    </>
  );
}

export { KBTextColumnsField, TEXT_COLUMNS_REQUIRED_MESSAGE };
export type { KBTextColumnsFieldProps };
