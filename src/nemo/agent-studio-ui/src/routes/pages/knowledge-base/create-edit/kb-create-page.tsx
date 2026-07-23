import type { ReactElement } from 'react';
import { useLocation } from 'react-router';

import { KBForm } from './form/kb-form';

function KBCreatePage(): ReactElement {
  const location = useLocation();

  return <KBForm key={location.pathname} />;
}

export { KBCreatePage };
