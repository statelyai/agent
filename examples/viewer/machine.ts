import { createMachine} from "xstate";

export const machine = createMachine({
    context: {
        js: null,
        css: null,
        bdds: null,
        html: null,
        jsonSpec: null,
        userMessages: [],
        screenSetSpec: null,
    },
    id: 'screen-set',
    initial: 'initializing',
    states: {
        initializing: {
            on: {
                start: {
                    target: 'understanding-requirements',
                },
            },
            description:
                'The AI agents team is initializing and preparing to start the collaboration process.',
        },
        'understanding-requirements': {
            on: {
                'receive-user-input': {
                    actions: ['logUserMessage', 'processUserInput'],
                },
                'generate-screen-set-spec': {
                    actions: 'generateScreenSetSpec',
                },
                'generate-bdds': {
                    actions: 'generateBDDs',
                },
                'requirements-understood': {
                    target: 'generating-json-spec',
                },
            },
            description:
                'The AI agents are actively chatting with the user to understand the requirements for the project and start generating initial artifacts like screen set spec and BDDs.',
        },
        'generating-json-spec': {
            on: {
                'generate-json-spec': {
                    actions: 'generateJSONSpec',
                },
                'json-spec-generated': {
                    target: 'generating-artifacts',
                },
            },
            description:
                'The AI agents are generating the JSON spec based on the understood requirements.',
        },
        'generating-artifacts': {
            on: {
                'generate-html': {
                    actions: 'generateHTML',
                },
                'generate-js': {
                    actions: 'generateJS',
                },
                'generate-css': {
                    actions: 'generateCSS',
                },
                'all-artifacts-generated': {
                    target: 'visualizing-results',
                },
            },
            description:
                'The AI agents are generating HTML, JS, and CSS artifacts based on the JSON spec and other requirements.',
        },
        'visualizing-results': {
            on: {
                'display-results': {
                    target: 'chatting-with-user',
                },
            },
            description:
                'The AI agents are visualizing the generated artifacts for the user and for each other to review and ensure everything is as required.',
        },
        'chatting-with-user': {
            on: {
                'receive-user-feedback': {
                    actions: ['logUserMessage', 'processUserFeedback'],
                },
                'adjustments-needed': {
                    target: 'updating-artifacts',
                },
                'user-satisfied': {
                    target: 'completed',
                },
            },
            description:
                'The AI agents are discussing the results with the user, gathering feedback, and making necessary adjustments.',
        },
        'updating-artifacts': {
            on: {
                'update-screen-set-spec': {
                    actions: 'updateScreenSetSpec',
                },
                'update-bdds': {
                    actions: 'updateBDDs',
                },
                'update-json-spec': {
                    actions: 'updateJSONSpec',
                },
                'update-html': {
                    actions: 'updateHTML',
                },
                'update-js': {
                    actions: 'updateJS',
                },
                'update-css': {
                    actions: 'updateCSS',
                },
                'updates-completed': {
                    target: 'visualizing-results',
                },
            },
            description:
                'The AI agents are updating the artifacts based on user feedback to meet the requirements accurately.',
        },
        completed: {
            type: 'final',
            description:
                'The AI agents have completed the project, and the user is satisfied with the results.',
        },
    },
} );
