import {
  Actor,
  assign,
  ContextFrom,
  createActor,
  EventFrom,
  log,
  OutputFrom,
  setup,
  StateFrom,
  TransitionConfig,
} from 'xstate';
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
} from '@langchain/core/prompts';
import { defineEvents } from '../src';
import { ChatOpenAI } from '@langchain/openai';
import * as fs from 'fs';
import { createLangchainAdapter } from '../src/adapters/langchain';
import { z } from 'zod';

const inputProperties = z.object({
  name: z.string({
    description: 'The name of the input field.',
  }),
  inputType: z.string({
    description: 'The type of the input field.',
  }),
  value: z.string({
    description: 'The value of the input field.',
  }),
  placeholder: z.string({
    description: 'The placeholder of the input field.',
  }),
  defaultValue: z.string({
    description: 'The default value of the input field.',
  }),
});

export type HtmlElement = Record<string, any> & { type: string };
export type HtmlElementMap = {
  [key: string]: HtmlElement[];
};
const llmSettings = createLangchainAdapter({
  model: new ChatOpenAI({
    modelName: 'gpt-4-32k',
  }),
});

const elementProperties = z.object({
  id: z
    .string({
      description: 'The id of the element.',
    })
    .optional(),
  class: z
    .string({
      description: 'The class of the element.',
    })
    .optional(),
  content: z
    .string({
      description: 'The content of the element.',
    })
    .optional(),
  data: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
      }),
      {
        description:
          'the data attributes. attributes that start with the prefix data-',
      }
    )
    .optional(),
});

const events = defineEvents({
  'element.link': z
    .object({
      text: z.string({
        description: 'The text of the link.',
      }),
      href: z.string({
        description: 'The href of the link.',
      }),
    })
    .merge(elementProperties),

  'element.button': z
    .object({
      text: z.string({
        description: 'The text of the button.',
      }),
      href: z.string({
        description: 'The href of the button.',
      }),
    })
    .merge(elementProperties),

  'element.form': z
    .object({
      action: z.string({
        description: 'The action of the form.',
      }),
      method: z.string({
        description: 'The method of the form.',
      }),
    })
    .merge(elementProperties),

  'element.input.text': inputProperties,
  'element.input.select': z
    .object({
      options: z.array(z.string()),
      selected: z.string(),
    })
    .merge(inputProperties),
  'element.input.textarea': inputProperties,
  'element.input.checkbox': z
    .object({
      checked: z.boolean(),
    })
    .merge(inputProperties),
  'element.input.radio': z
    .object({
      options: z.array(z.string()),
      selected: z.string(),
    })
    .merge(inputProperties),
});

const elementStream = llmSettings.fromEvent(
  ChatPromptTemplate.fromMessages([
    SystemMessagePromptTemplate.fromTemplate(`You are a programmer and your job is to pick out information in code to a pm. You are working on an html file. You will extract the necessary content asked from the information provided.
 make sure to include include all data attributes on the elements
 {instructions}
`),
    HumanMessagePromptTemplate.fromTemplate(` 
  Here is the overview of the site. Format is in html:
      """
      {html}
  """
  
 `),
  ])
);

const search = llmSettings.fromCallback(
  ChatPromptTemplate.fromMessages([
    SystemMessagePromptTemplate.fromTemplate(`You are a programmer and your job is to pick out information in code to a pm. You are working on an html file. You will extract the necessary content asked from the information provided.
 make sure to include include all data attributes on the elements
 Search for {instructions}
`),
    HumanMessagePromptTemplate.fromTemplate(` 
  Here is the overview of the site. Format is in html:
      """
      {html}
  """`),
  ])
);

type HtmlElementContext = {
  html: string;
  instructions: string;
  elements: HtmlElementMap;
  limit: number;
};

export const elementMachine = setup({
  schemas: {
    events: events.schemas,
  },
  types: {
    events: events.types,
    context: {} as HtmlElementContext,
    input: {} as Partial<HtmlElementContext> & Pick<HtmlElementContext, 'html'>,
    output: { elements: {} as HtmlElementMap },
  },
  actors: {
    'element-stream': elementStream,
  },
}).createMachine({
  context: ({ input }) => ({
    html: input.html,
    instructions: input.instructions || '',
    elements: (input.elements as HtmlElementMap) || {},
    limit: input.limit || 100,
  }),
  invoke: {
    src: 'element-stream',
    input: ({ context: { html, instructions, elements } }) => ({
      html: html,
      instructions: instructions,
      elements: JSON.stringify(elements),
    }),
    onSnapshot: {
      actions: [
        log((event) => {
          return event;
        }),
      ],
    },
  },
  on: {
    ...Object.entries(events.schemas).reduce((acc, [name, schema]) => {
      acc[name] = {
        actions: assign({
          elements: ({ context: { elements }, event }) => ({
            ...elements,
            [event.type]: [...(elements[event.type] || []), event],
          }),
        }),
      };
      return acc;
    }, {} as Record<string, ElementMachineTransition>),
  },
});

const actor: Actor<ElementMachine> = createActor(elementMachine, {
  input: {
    //ignore html input in ts
    //@ts-ignore
    html: `<div data-width="auto" class="gigya-screen v2 portrait" gigya-conditional:class="viewport.width < 500 ?gigya-screen v2 portrait mobile:" data-on-pending-verification-screen="gigya-verification-sent-screen" gigya-expression:data-caption="screenset.translations['GIGYA_COMPLETE_REGISTRATION_SCREEN_CAPTION']" data-screenset-element-id="gigya-complete-registration-screen" data-screenset-element-id-publish="true" data-screenset-roles="instance" gigya-default-class="gigya-screen v2 portrait" gigya-default-data-caption="null" id="gigya-complete-registration-screen" data-caption="Profile Completion">
        <form class="gigya-profile-form" onsubmit="return false;" method="post" data-screenset-element-id="gigya-profile-form" data-screenset-element-id-publish="true" data-screenset-roles="instance" id="gigya-profile-form">
            <div class="gigya-layout-row">
                <label class="gigya-label-text gigya-composite-control gigya-composite-control-label main-text" data-translation-key="LABEL_82751524717670350_LABEL" data-screenset-element-id="__gig_template_element_54_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">We still need a few more details:</label>
                <div class="gigya-composite-control gigya-composite-control-textbox" style="display: block;">
                    <label class="gigya-label" for="gigya-textbox-email">
                        <span class="gigya-label-text" data-translation-key="TEXTBOX_136884197726350880_LABEL" data-screenset-element-id="__gig_template_element_55_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">Email:</span>
                        <label class="gigya-required-display gigya-reset" data-bound-to="email" style="" data-screenset-element-id="__gig_template_element_49_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-hidden="true">*</label>
                    </label>
                    <input type="text" value="" name="email" class="gigya-input-text" formnovalidate="formnovalidate" tabindex="0" data-screenset-element-id="gigya-textbox-email" data-screenset-element-id-publish="true" data-screenset-roles="instance" data-gigya-name="email" data-original-value="" id="gigya-textbox-email" aria-required="true">
                    <span class="gigya-error-msg" data-bound-to="email" data-screenset-element-id="__gig_template_element_43_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-atomic="true"></span>
                </div>
                <div class="gigya-composite-control gigya-composite-control-dropdown" style="display: block;">
                    <label class="gigya-label" for="gigya-dropdown-birthYear">
                        <span class="gigya-label-text" data-translation-key="DROPDOWN_16234574578704520_LABEL" data-screenset-element-id="__gig_template_element_56_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">Year of birth:</span>
                        <label class="gigya-required-display gigya-reset gigya-hidden" data-bound-to="profile.birthYear" style="" data-screenset-element-id="__gig_template_element_50_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-hidden="true">*</label>
                    </label>
                    <select name="profile.birthYear" tabindex="0" data-screenset-element-id="gigya-dropdown-birthYear" data-screenset-element-id-publish="true" data-screenset-roles="instance" data-gigya-name="profile.birthYear" data-original-value="" id="gigya-dropdown-birthYear" aria-required="false"> <option value="" data-translation-key="DROPDOWN_16234574578704520_CHOICES_" data-screenset-element-id="__gig_template_element_57_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance"></option> <option value="1920" data-translation-key="DROPDOWN_16234574578704520_CHOICES_44968AECE94F667E4095002D140B5896" data-screenset-element-id="__gig_template_element_58_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1920</option> <option value="1921" data-translation-key="DROPDOWN_16234574578704520_CHOICES_9F6992966D4C363EA0162A056CB45FE5" data-screenset-element-id="__gig_template_element_59_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1921</option> <option value="1922" data-translation-key="DROPDOWN_16234574578704520_CHOICES_333222170AB9EDCA4785C39F55221FE7" data-screenset-element-id="__gig_template_element_60_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1922</option> <option value="1923" data-translation-key="DROPDOWN_16234574578704520_CHOICES_414E773D5B7E5C06D564F594BF6384D0" data-screenset-element-id="__gig_template_element_61_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1923</option> <option value="1924" data-translation-key="DROPDOWN_16234574578704520_CHOICES_B139E104214A08AE3F2EBCCE149CDF6E" data-screenset-element-id="__gig_template_element_62_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1924</option> <option value="1925" data-translation-key="DROPDOWN_16234574578704520_CHOICES_0950CA92A4DCF426067CFD2246BB5FF3" data-screenset-element-id="__gig_template_element_63_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1925</option> <option value="1926" data-translation-key="DROPDOWN_16234574578704520_CHOICES_5103C3584B063C431BD1268E9B5E76FB" data-screenset-element-id="__gig_template_element_64_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1926</option> <option value="1927" data-translation-key="DROPDOWN_16234574578704520_CHOICES_E5B294B70C9647DCF804D7BAA1903918" data-screenset-element-id="__gig_template_element_65_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1927</option> <option value="1928" data-translation-key="DROPDOWN_16234574578704520_CHOICES_5BCE843DD76DB8C939D5323DD3E54EC9" data-screenset-element-id="__gig_template_element_66_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1928</option> <option value="1929" data-translation-key="DROPDOWN_16234574578704520_CHOICES_139F0874F2DED2E41B0393C4AC5644F7" data-screenset-element-id="__gig_template_element_67_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1929</option> <option value="1930" data-translation-key="DROPDOWN_16234574578704520_CHOICES_29530DE21430B7540EC3F65135F7323C" data-screenset-element-id="__gig_template_element_68_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1930</option> <option value="1931" data-translation-key="DROPDOWN_16234574578704520_CHOICES_15D185EAA7C954E77F5343D941E25FBD" data-screenset-element-id="__gig_template_element_69_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1931</option> <option value="1932" data-translation-key="DROPDOWN_16234574578704520_CHOICES_52D2752B150F9C35CCB6869CBF074E48" data-screenset-element-id="__gig_template_element_70_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1932</option> <option value="1933" data-translation-key="DROPDOWN_16234574578704520_CHOICES_1E913E1B06EAD0B66E30B6867BF63549" data-screenset-element-id="__gig_template_element_71_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1933</option> <option value="1934" data-translation-key="DROPDOWN_16234574578704520_CHOICES_8562AE5E286544710B2E7EBE9858833B" data-screenset-element-id="__gig_template_element_72_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1934</option> <option value="1935" data-translation-key="DROPDOWN_16234574578704520_CHOICES_8D55A249E6BAA5C06772297520DA2051" data-screenset-element-id="__gig_template_element_73_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1935</option> <option value="1936" data-translation-key="DROPDOWN_16234574578704520_CHOICES_11108A3DBFE4636CB40B84B803B2FFF6" data-screenset-element-id="__gig_template_element_74_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1936</option> <option value="1937" data-translation-key="DROPDOWN_16234574578704520_CHOICES_136F951362DAB62E64EB8E841183C2A9" data-screenset-element-id="__gig_template_element_75_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1937</option> <option value="1938" data-translation-key="DROPDOWN_16234574578704520_CHOICES_AD4CC1FB9B068FAECFB70914ACC63395" data-screenset-element-id="__gig_template_element_76_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1938</option> <option value="1939" data-translation-key="DROPDOWN_16234574578704520_CHOICES_F22E4747DA1AA27E363D86D40FF442FE" data-screenset-element-id="__gig_template_element_77_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1939</option> <option value="1940" data-translation-key="DROPDOWN_16234574578704520_CHOICES_95E6834D0A3D99E9EA8811855AE9229D" data-screenset-element-id="__gig_template_element_78_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1940</option> <option value="1941" data-translation-key="DROPDOWN_16234574578704520_CHOICES_7AF6266CC52234B5AA339B16695F7FC4" data-screenset-element-id="__gig_template_element_79_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1941</option> <option value="1942" data-translation-key="DROPDOWN_16234574578704520_CHOICES_519C84155964659375821F7CA576F095" data-screenset-element-id="__gig_template_element_80_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1942</option> <option value="1943" data-translation-key="DROPDOWN_16234574578704520_CHOICES_C3395DD46C34FA7FD8D729D8CF88B7A8" data-screenset-element-id="__gig_template_element_81_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1943</option> <option value="1944" data-translation-key="DROPDOWN_16234574578704520_CHOICES_6F2688A5FCE7D48C8D19762B88C32C3B" data-screenset-element-id="__gig_template_element_82_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1944</option> <option value="1945" data-translation-key="DROPDOWN_16234574578704520_CHOICES_2D00F43F07911355D4151F13925FF292" data-screenset-element-id="__gig_template_element_83_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1945</option> <option value="1946" data-translation-key="DROPDOWN_16234574578704520_CHOICES_1F71E393B3809197ED66DF836FE833E5" data-screenset-element-id="__gig_template_element_84_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1946</option> <option value="1947" data-translation-key="DROPDOWN_16234574578704520_CHOICES_DE03BEFFEED9DA5F3639A621BCAB5DD4" data-screenset-element-id="__gig_template_element_85_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1947</option> <option value="1948" data-translation-key="DROPDOWN_16234574578704520_CHOICES_7CA57A9F85A19A6E4B9A248C1DACA185" data-screenset-element-id="__gig_template_element_86_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1948</option> <option value="1949" data-translation-key="DROPDOWN_16234574578704520_CHOICES_36AC8E558AC7690B6F44E2CB5EF93322" data-screenset-element-id="__gig_template_element_87_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1949</option> <option value="1950" data-translation-key="DROPDOWN_16234574578704520_CHOICES_03E7D2EBEC1E820AC34D054DF7E68F48" data-screenset-element-id="__gig_template_element_88_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1950</option> <option value="1951" data-translation-key="DROPDOWN_16234574578704520_CHOICES_6A508A60AA3BF9510EA6ACB021C94B48" data-screenset-element-id="__gig_template_element_89_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1951</option> <option value="1952" data-translation-key="DROPDOWN_16234574578704520_CHOICES_1113D7A76FFCECA1BB350BFE145467C6" data-screenset-element-id="__gig_template_element_90_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1952</option> <option value="1953" data-translation-key="DROPDOWN_16234574578704520_CHOICES_A38B16173474BA8B1A95BCBC30D3B8A5" data-screenset-element-id="__gig_template_element_91_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1953</option> <option value="1954" data-translation-key="DROPDOWN_16234574578704520_CHOICES_5A7F963E5E0504740C3A6B10BB6D4FA5" data-screenset-element-id="__gig_template_element_92_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1954</option> <option value="1955" data-translation-key="DROPDOWN_16234574578704520_CHOICES_378A063B8FDB1DB941E34F4BDE584C7D" data-screenset-element-id="__gig_template_element_93_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1955</option> <option value="1956" data-translation-key="DROPDOWN_16234574578704520_CHOICES_E3408432C1A48A52FB6C74D926B38886" data-screenset-element-id="__gig_template_element_94_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1956</option> <option value="1957" data-translation-key="DROPDOWN_16234574578704520_CHOICES_277A78FC05C8864A170E9A56CEEABC4C" data-screenset-element-id="__gig_template_element_95_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1957</option> <option value="1958" data-translation-key="DROPDOWN_16234574578704520_CHOICES_D77F00766FD3BE3F2189C843A6AF3FB2" data-screenset-element-id="__gig_template_element_96_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1958</option> <option value="1959" data-translation-key="DROPDOWN_16234574578704520_CHOICES_E4DD5528F7596DCDF871AA55CFCCC53C" data-screenset-element-id="__gig_template_element_97_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1959</option> <option value="1960" data-translation-key="DROPDOWN_16234574578704520_CHOICES_7F16109F1619FD7A733DAF5A84C708C1" data-screenset-element-id="__gig_template_element_98_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1960</option> <option value="1961" data-translation-key="DROPDOWN_16234574578704520_CHOICES_F106B7F99D2CB30C3DB1C3CC0FDE9CCB" data-screenset-element-id="__gig_template_element_99_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1961</option> <option value="1962" data-translation-key="DROPDOWN_16234574578704520_CHOICES_95F6870FF3DCD442254E334A9033D349" data-screenset-element-id="__gig_template_element_100_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1962</option> <option value="1963" data-translation-key="DROPDOWN_16234574578704520_CHOICES_C215B446BCDF956D848A8419C1B5A920" data-screenset-element-id="__gig_template_element_101_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1963</option> <option value="1964" data-translation-key="DROPDOWN_16234574578704520_CHOICES_39DCAF7A053DC372FBC391D4E6B5D693" data-screenset-element-id="__gig_template_element_102_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1964</option> <option value="1965" data-translation-key="DROPDOWN_16234574578704520_CHOICES_D46E1FCF4C07CE4A69EE07E4134BCEF1" data-screenset-element-id="__gig_template_element_103_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1965</option> <option value="1966" data-translation-key="DROPDOWN_16234574578704520_CHOICES_3683AF9D6F6C06ACEE72992F2977F67E" data-screenset-element-id="__gig_template_element_104_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1966</option> <option value="1967" data-translation-key="DROPDOWN_16234574578704520_CHOICES_A82D922B133BE19C1171534E6594F754" data-screenset-element-id="__gig_template_element_105_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1967</option> <option value="1968" data-translation-key="DROPDOWN_16234574578704520_CHOICES_98C7242894844ECD6EC94AF67AC8247D" data-screenset-element-id="__gig_template_element_106_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1968</option> <option value="1969" data-translation-key="DROPDOWN_16234574578704520_CHOICES_4D8556695C262AB91FF51A943FDD6058" data-screenset-element-id="__gig_template_element_107_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1969</option> <option value="1970" data-translation-key="DROPDOWN_16234574578704520_CHOICES_0004D0B59E19461FF126E3A08A814C33" data-screenset-element-id="__gig_template_element_108_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1970</option> <option value="1971" data-translation-key="DROPDOWN_16234574578704520_CHOICES_DE73998802680548B916F1947FFBAD76" data-screenset-element-id="__gig_template_element_109_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1971</option> <option value="1972" data-translation-key="DROPDOWN_16234574578704520_CHOICES_C4DE8CED6214345614D33FB0B16A8ACD" data-screenset-element-id="__gig_template_element_110_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1972</option> <option value="1973" data-translation-key="DROPDOWN_16234574578704520_CHOICES_DEB54FFB41E085FD7F69A75B6359C989" data-screenset-element-id="__gig_template_element_111_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1973</option> <option value="1974" data-translation-key="DROPDOWN_16234574578704520_CHOICES_3D863B367AA379F71C7AFC0C9CDCA41D" data-screenset-element-id="__gig_template_element_112_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1974</option> <option value="1975" data-translation-key="DROPDOWN_16234574578704520_CHOICES_7D2B92B6726C241134DAE6CD3FB8C182" data-screenset-element-id="__gig_template_element_113_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1975</option> <option value="1976" data-translation-key="DROPDOWN_16234574578704520_CHOICES_DD055F53A45702FE05E449C30AC80DF9" data-screenset-element-id="__gig_template_element_114_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1976</option> <option value="1977" data-translation-key="DROPDOWN_16234574578704520_CHOICES_4AFD521D77158E02AED37E2274B90C9C" data-screenset-element-id="__gig_template_element_115_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1977</option> <option value="1978" data-translation-key="DROPDOWN_16234574578704520_CHOICES_405E28906322882C5BE9B4B27F4C35FD" data-screenset-element-id="__gig_template_element_116_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1978</option> <option value="1979" data-translation-key="DROPDOWN_16234574578704520_CHOICES_798CEBCCB32617AD94123450FD137104" data-screenset-element-id="__gig_template_element_117_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1979</option> <option value="1980" data-translation-key="DROPDOWN_16234574578704520_CHOICES_F80BF05527157A8C2A7BB63B22F49AAA" data-screenset-element-id="__gig_template_element_118_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1980</option> <option value="1981" data-translation-key="DROPDOWN_16234574578704520_CHOICES_B3B4D2DBEDC99FE843FD3DEDB02F086F" data-screenset-element-id="__gig_template_element_119_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1981</option> <option value="1982" data-translation-key="DROPDOWN_16234574578704520_CHOICES_FB87582825F9D28A8D42C5E5E5E8B23D" data-screenset-element-id="__gig_template_element_120_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1982</option> <option value="1983" data-translation-key="DROPDOWN_16234574578704520_CHOICES_1E4D36177D71BBB3558E43AF9577D70E" data-screenset-element-id="__gig_template_element_121_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1983</option> <option value="1984" data-translation-key="DROPDOWN_16234574578704520_CHOICES_1B36EA1C9B7A1C3AD668B8BB5DF7963F" data-screenset-element-id="__gig_template_element_122_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1984</option> <option value="1985" data-translation-key="DROPDOWN_16234574578704520_CHOICES_1F36C15D6A3D18D52E8D493BC8187CB9" data-screenset-element-id="__gig_template_element_123_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1985</option> <option value="1986" data-translation-key="DROPDOWN_16234574578704520_CHOICES_8C249675AEA6C3CBD91661BBAE767FF1" data-screenset-element-id="__gig_template_element_124_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1986</option> <option value="1987" data-translation-key="DROPDOWN_16234574578704520_CHOICES_D68A18275455AE3EAA2C291EEBB46E6D" data-screenset-element-id="__gig_template_element_125_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1987</option> <option value="1988" data-translation-key="DROPDOWN_16234574578704520_CHOICES_9D7311BA459F9E45ED746755A32DCD11" data-screenset-element-id="__gig_template_element_126_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1988</option> <option value="1989" data-translation-key="DROPDOWN_16234574578704520_CHOICES_4A3E00961A08879C34F91CA0070EA2F5" data-screenset-element-id="__gig_template_element_127_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1989</option> <option value="1990" data-translation-key="DROPDOWN_16234574578704520_CHOICES_DC513EA4FBDAA7A14786FFDEBC4EF64E" data-screenset-element-id="__gig_template_element_128_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1990</option> <option value="1991" data-translation-key="DROPDOWN_16234574578704520_CHOICES_96055F5B06BF9381AC43879351642CF5" data-screenset-element-id="__gig_template_element_129_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1991</option> <option value="1992" data-translation-key="DROPDOWN_16234574578704520_CHOICES_D5C186983B52C4551EE00F72316C6EAA" data-screenset-element-id="__gig_template_element_130_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1992</option> <option value="1993" data-translation-key="DROPDOWN_16234574578704520_CHOICES_C5A4E7E6882845EA7BB4D9462868219B" data-screenset-element-id="__gig_template_element_131_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1993</option> <option value="1994" data-translation-key="DROPDOWN_16234574578704520_CHOICES_008BD5AD93B754D500338C253D9C1770" data-screenset-element-id="__gig_template_element_132_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1994</option> <option value="1995" data-translation-key="DROPDOWN_16234574578704520_CHOICES_3F088EBEDA03513BE71D34D214291986" data-screenset-element-id="__gig_template_element_133_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1995</option> <option value="1996" data-translation-key="DROPDOWN_16234574578704520_CHOICES_6351BF9DCE654515BF1DDBD6426DFA97" data-screenset-element-id="__gig_template_element_134_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1996</option> <option value="1997" data-translation-key="DROPDOWN_16234574578704520_CHOICES_06964DCE9ADDB1C5CB5D6E3D9838F733" data-screenset-element-id="__gig_template_element_135_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1997</option> <option value="1998" data-translation-key="DROPDOWN_16234574578704520_CHOICES_C5B2CEBF15B205503560C4E8E6D1EA78" data-screenset-element-id="__gig_template_element_136_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1998</option> <option value="1999" data-translation-key="DROPDOWN_16234574578704520_CHOICES_5EC829DEBE54B19A5F78D9A65B900A39" data-screenset-element-id="__gig_template_element_137_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">1999</option> <option value="2000" data-translation-key="DROPDOWN_16234574578704520_CHOICES_08F90C1A417155361A5C4B8D297E0D78" data-screenset-element-id="__gig_template_element_138_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">2000</option> <option value="2001" data-translation-key="DROPDOWN_16234574578704520_CHOICES_D0FB963FF976F9C37FC81FE03C21EA7B" data-screenset-element-id="__gig_template_element_139_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">2001</option> <option value="2002" data-translation-key="DROPDOWN_16234574578704520_CHOICES_4BA29B9F9E5732ED33761840F4BA6C53" data-screenset-element-id="__gig_template_element_140_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">2002</option> <option value="2003" data-translation-key="DROPDOWN_16234574578704520_CHOICES_A591024321C5E2BDBD23ED35F0574DDE" data-screenset-element-id="__gig_template_element_141_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">2003</option> <option value="2004" data-translation-key="DROPDOWN_16234574578704520_CHOICES_B8B4B727D6F5D1B61FFF7BE687F7970F" data-screenset-element-id="__gig_template_element_142_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">2004</option> </select> <span class="gigya-error-msg" data-bound-to="profile.birthYear" data-screenset-element-id="__gig_template_element_44_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-atomic="true"></span> </div> <div class="gigya-composite-control gigya-composite-control-textbox"> <label class="gigya-label" data-binding="true" data-screenset-element-id="__gig_template_element_146_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance" for="gigya-textbox-121660051719898560"><span class="gigya-label-text" data-translation-key="TEXTBOX_121660051719898560_LABEL" data-screenset-element-id="__gig_template_element_143_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance,template">Degree</span><label class="gigya-required-display gigya-reset gigya-hidden" data-bound-to="profile.education.degree" style="" data-screenset-element-id="__gig_template_element_51_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-hidden="true">*</label></label> <input type="text" class="gigya-input-text" autocomplete="on" show-valid-checkmark="true" data-gigya-type="text" name="profile.education.degree" data-screenset-element-id="gigya-textbox-121660051719898560" data-screenset-element-id-publish="true" data-screenset-roles="instance" data-gigya-name="profile.education.degree" data-original-value="" id="gigya-textbox-121660051719898560" aria-required="false" aria-invalid="false"> <span class="gigya-error-msg" data-bound-to="profile.education.degree" data-screenset-element-id="__gig_template_element_45_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-atomic="true"></span> </div><div class="gigya-composite-control gigya-composite-control-textbox" style="display: block;"> <label class="gigya-label" for="gigya-textbox-zip"> <span class="gigya-label-text" data-translation-key="TEXTBOX_65559603100946710_LABEL" data-screenset-element-id="__gig_template_element_144_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">Postcode:</span> <label class="gigya-required-display gigya-reset gigya-hidden" data-bound-to="profile.zip" style="" data-screenset-element-id="__gig_template_element_52_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-hidden="true">*</label> </label> <input type="text" value="" name="profile.zip" class="gigya-input-text" tabindex="0" data-screenset-element-id="gigya-textbox-zip" data-screenset-element-id-publish="true" data-screenset-roles="instance" data-gigya-name="profile.zip" data-original-value="" id="gigya-textbox-zip" aria-required="false"> <span class="gigya-error-msg" data-bound-to="profile.zip" data-screenset-element-id="__gig_template_element_46_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-atomic="true"></span> </div> <div class="gigya-composite-control gigya-composite-control-checkbox" aria-invalid="false"> <input type="checkbox" class="gigya-input-checkbox" name="subscriptions.news.email.isSubscribed" tabindex="0" data-screenset-element-id="gigya-checkbox-subscribe" data-screenset-element-id-publish="true" data-screenset-roles="instance" data-gigya-name="subscriptions.news.email.isSubscribed" data-original-value="false" id="gigya-checkbox-subscribe" aria-required="false"> <label class="gigya-label" for="gigya-checkbox-subscribe"> <span class="gigya-label-text" data-translation-key="CHECKBOX_76245746717438300_LABEL" data-screenset-element-id="__gig_template_element_145_1707128884362" data-screenset-element-id-publish="false" data-screenset-roles="instance">Subscribe to our newsletter</span> <label class="gigya-required-display gigya-reset gigya-hidden" data-bound-to="subscriptions.news.email.isSubscribed" style="" data-screenset-element-id="__gig_template_element_53_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-hidden="true">*</label> </label> </div> </div> <div class="gigya-layout-row"> <div class="gigya-composite-control gigya-composite-control-submit" style="display: block;"> <input type="submit" class="gigya-input-submit" tabindex="0" gigya-expression:value="screenset.translations['SUBMIT_31429658457676556_VALUE']" data-screenset-element-id="__gig_template_element_48_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" gigya-default-value="null" value="Submit"> </div> </div> <div class="gigya-layout-row"> <div class="gigya-error-display gigya-composite-control gigya-composite-control-form-error" data-bound-to="gigya-profile-form" data-screenset-element-id="__gig_template_element_42_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-atomic="true"> <div class="gigya-error-msg gigya-form-error-msg" data-bound-to="gigya-profile-form" data-screenset-element-id="__gig_template_element_47_1707128884361" data-screenset-element-id-publish="false" data-screenset-roles="instance" aria-atomic="true"></div> </div> </div> <div class="gigya-layout-row"></div> <div class="gigya-clear"></div> </form> </div>`,
    instructions: 'find all input element on the form',
  },
  inspect: {
    next: (e) => {
      if (e.type === '@xstate.snapshot') {
        fs.writeFile(
          'outputs/html-elements.json',
          JSON.stringify(actor.getPersistedSnapshot(), null, 2) + '\n',
          (err) => {
            if (err) console.error(err);
          }
        );
      }
      fs.appendFile(
        'outputs/html-elements.log.jsonl',
        JSON.stringify(e, null, 2),
        (err) => {
          if (err) console.error(err);
        }
      );
    },
    complete: () =>
      fs.writeFileSync(
        'html-elements.json',
        JSON.stringify(actor.getPersistedSnapshot(), null, 2)
      ),
  },
});

export type ElementMachine = typeof elementMachine;
export type ElementMachineEvents = EventFrom<ElementMachine>;
export type ElementMachineOutput = OutputFrom<ElementMachine>;
export type ElementMachineState = StateFrom<ElementMachine>;
export type ElementMachineActor = Actor<ElementMachine>;
export type ElementMachineSnapshot = ReturnType<
  ElementMachineActor['getSnapshot']
>;
export type ElementMachineEventObject =
  ElementMachineEvents[keyof ElementMachineEvents];
export type ElementMachineTransition = TransitionConfig<
  HtmlElementContext,
  ElementMachineEvents,
  ElementMachineEvents,
  any,
  any,
  any,
  any
>;

actor.subscribe((s) => {
  console.log(s.value, s.context);
});
actor.start();
