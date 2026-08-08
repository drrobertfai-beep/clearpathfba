export const dataPointVocab = {
 settings: ['classroom','playground','home','community','therapy_1on1','group_instruction','transition','mealtime','other'],
 antecedents: ['demand_task','transition','attention_diverted','denied_access','unstructured_time','peer_interaction','sensory_stimulation','reprimand_correction','other'],
 consequences: ['attention_given','escape_removed_demand','access_preferred_item','sensory_stimulation','ignored_no_consequence','redirected','peer_attention','other'],
 measurementTypes: ['frequency','duration','latency']
};

// Human-readable display labels for vocabulary codes and hypothesis values.
// Used by the analysis engine (rationale text) and available to the UI.
export const LABELS = {
 settings: { classroom:'Classroom', playground:'Playground', home:'Home', community:'Community', therapy_1on1:'1:1 therapy', group_instruction:'Group instruction', transition:'Transition', mealtime:'Mealtime', other:'Other' },
 antecedents: { demand_task:'Demand/task', transition:'Transition', attention_diverted:'Attention diverted', denied_access:'Denied access', unstructured_time:'Unstructured time', peer_interaction:'Peer interaction', sensory_stimulation:'Sensory stimulation', reprimand_correction:'Reprimand/correction', other:'Other' },
 consequences: { attention_given:'Attention given', escape_removed_demand:'Demand removed (escape)', access_preferred_item:'Preferred item access', sensory_stimulation:'Sensory stimulation', ignored_no_consequence:'Ignored/no consequence', redirected:'Redirected', peer_attention:'Peer attention', other:'Other' },
 measurementTypes: { frequency:'Frequency', duration:'Duration', latency:'Latency' },
 functions: { escape:'Escape', attention:'Attention', tangible:'Tangible', automatic:'Automatic', multiple:'Multiple', undetermined:'Undetermined' }
};
export default dataPointVocab;
