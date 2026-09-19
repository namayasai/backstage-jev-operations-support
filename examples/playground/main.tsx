import { createRoot } from 'react-dom/client';
import { demoEvaluation } from '../../plugins/jev-common/src';
import { JevWorkbench } from '../../plugins/jev/src/Workbench';

createRoot(document.getElementById('root')!).render(<JevWorkbench demo evaluate={async input => demoEvaluation(input)} />);
