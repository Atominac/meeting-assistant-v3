// Summary templates. Every template returns the same JSON shape; only what the notes focus on changes.
export const TEMPLATES = [
  { id: 'general', label: 'General meeting', focus: 'A general meeting. Cover what was discussed, what was decided, and who needs to do what.' },
  { id: 'sales', label: 'Sales call', focus: 'A sales call. In the overview cover who the buyer is, their need, budget, timeline and who decides. keyPoints: objections raised and how they were answered, competitors mentioned, buying signals. decisions: agreed next steps. actionItems: follow-ups for both sides with owners and dates.' },
  { id: 'discovery', label: 'Discovery call', focus: 'A discovery call. In the overview cover the prospect\'s situation and goals. keyPoints: pain points, current tools or process, requirements, constraints and success criteria. actionItems: what each side promised to send or do next.' },
  { id: 'support', label: 'Customer support call', focus: 'A customer support call. In the overview state the customer\'s problem and whether it was resolved. keyPoints: symptoms, steps tried, root cause if found, and the customer\'s mood. decisions: the resolution or workaround. actionItems: follow-ups with owners.' },
  { id: 'interview', label: 'Interview', focus: 'A job interview. In the overview cover the role and the candidate\'s background. keyPoints: strengths, concerns, notable answers, and questions the candidate asked. decisions: any hiring decision or recommendation. actionItems: next steps in the process. Report only what was said; do not add your own opinion of the candidate.' },
  { id: 'standup', label: 'Team standup', focus: 'A team standup. In the overview give a one or two sentence status. keyPoints: progress per person (use their names). decisions: anything agreed. actionItems: blockers and who will unblock them.' },
];
export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
export const publicTemplates = () => TEMPLATES.map(({ id, label }) => ({ id, label }));
