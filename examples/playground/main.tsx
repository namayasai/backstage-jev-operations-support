import { createRoot } from 'react-dom/client';
import { demoEvaluation } from '../../plugins/jev-operations-support-common/src';
import { JevWorkbench } from '../../plugins/jev-operations-support/src/Workbench';

createRoot(document.getElementById('root')!).render(<JevWorkbench demo evaluate={async input => demoEvaluation(input)} />);
