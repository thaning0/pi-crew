export const CREW_BATCH_TEMPLATE_REGISTRY = {
	"parallel-work-aggregate": {
		description: "Run workers in parallel and aggregate their terminal replies.",
	},
	"plan-review-loop": {
		description: "Run a plan author plus reviewer loop until pass or round exhaustion.",
	},
	"implement-review-loop": {
		description: "Run an implementation author plus reviewer loop until pass or round exhaustion.",
	},
	"review-fix-loop": {
		description: "Run a reviewer-first loop where the reviewer examines an existing artifact and the fixer resolves issues.",
	},
} as const;

export type CrewBatchTemplateName = keyof typeof CREW_BATCH_TEMPLATE_REGISTRY;

export const CREW_BATCH_TEMPLATE_NAMES = Object.keys(
	CREW_BATCH_TEMPLATE_REGISTRY,
) as CrewBatchTemplateName[];

export const CREW_BATCH_TEMPLATE_ENUM = [...CREW_BATCH_TEMPLATE_NAMES];

export const CREW_BATCH_SUPPORTED_TEMPLATES_TEXT =
	CREW_BATCH_TEMPLATE_NAMES.join(", ");

export const CREW_BATCH_TOOL_DESCRIPTION =
	`Run a built-in multi-agent batch template. Supported templates: ${CREW_BATCH_SUPPORTED_TEMPLATES_TEXT}.`;

export const CREW_BATCH_TEMPLATE_PARAMETER_DESCRIPTION =
	`Built-in batch template name. Supported templates: ${CREW_BATCH_SUPPORTED_TEMPLATES_TEXT}.`;

export function isKnownBatchTemplate(
	value: string,
): value is CrewBatchTemplateName {
	return CREW_BATCH_TEMPLATE_NAMES.includes(value as CrewBatchTemplateName);
}
