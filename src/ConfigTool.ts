const DEFAULT_CONFIG_API_BASE_URL = '/__config-tool/api';
const DEFAULT_STATIC_CONFIG_BASE_URL = '/config';
const BASIC_TYPES = ['string', 'number', 'boolean'] as const;
const FIELD_BASE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
const FIELD_TYPES = ['string', 'number', 'boolean', 'number[]', 'string[]', 'boolean[]', 'json', 'json[]'] as const;
const STRUCTURE_FIELD_TYPES = ['string', 'number', 'boolean', 'number[]', 'string[]', 'boolean[]'] as const;
const NUMBER_CONSTRAINT_KINDS = ['number', 'reference', 'enum'] as const;
const MODULE_KEY_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const STRUCTURE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const REQUIRED_CSV_FIELDS = ['id', 'name'] as const;

type BasicType = typeof BASIC_TYPES[number];
type FieldBaseType = typeof FIELD_BASE_TYPES[number];
export type FieldType = typeof FIELD_TYPES[number];
export type StructureFieldType = typeof STRUCTURE_FIELD_TYPES[number];
export type NumberConstraintKind = typeof NUMBER_CONSTRAINT_KINDS[number];
export type CsvRow = Record<string, string>;
export interface ConfigModuleTree {
    [key: string]: string | ConfigModuleTree;
}
export type Manifest = Record<string, unknown> & { modules?: ConfigModuleTree };
type TableTab = 'schema' | 'data';

export interface FieldSchema {
    key: string;
    type: FieldType;
    description: string;
    structure?: string;
    numberConstraint?: NumberConstraintSchema;
}

export interface StructureFieldSchema {
    key: string;
    type: StructureFieldType;
    description: string;
    numberConstraint?: NumberConstraintSchema;
}

export interface EnumValueSchema {
    key: string;
    value: number;
    description: string;
}

export interface EnumSchema {
    description: string;
    values: EnumValueSchema[];
}

export interface NumberConstraintSchema {
    kind: NumberConstraintKind;
    min?: number;
    max?: number;
    table?: string;
    enum?: string;
}

export interface StructureSchema {
    description: string;
    fields: StructureFieldSchema[];
}

export interface ConfigSchema {
    version: number;
    tables: Record<string, { path: string; fields: FieldSchema[] }>;
    constants: Record<string, { path: string; description: string }>;
    structures: Record<string, StructureSchema>;
    enums: Record<string, EnumSchema>;
}

export interface CsvTablePayload {
    moduleKey: string;
    path: string;
    fields: FieldSchema[];
    rows: CsvRow[];
}

export interface ConstantPayload {
    moduleKey: string;
    path: string;
    description: string;
    text: string;
}

export interface ConfigToolPayload {
    writable: boolean;
    manifest: Manifest;
    schema: ConfigSchema;
    tables: CsvTablePayload[];
    constants: ConstantPayload[];
}

export interface ConfigToolSaveRequest {
    manifest: Manifest;
    schema: ConfigSchema;
    tables: CsvTablePayload[];
    constants: ConstantPayload[];
    deletedPaths: string[];
}

interface CsvTableState extends CsvTablePayload {
    id: string;
    originalPath: string;
    activeTab: TableTab;
    savedModuleKey: string;
    savedFields: FieldSchema[];
    savedRows: CsvRow[];
    selectedFieldIndex?: number;
    selectedRowIndex?: number;
}

interface ConstantState extends ConstantPayload {
    id: string;
    originalPath: string;
    savedModuleKey: string;
    savedDescription: string;
    savedText: string;
}

interface StructureState extends StructureSchema {
    id: string;
    key: string;
    savedFields: StructureFieldSchema[];
    selectedFieldIndex?: number;
}

interface EnumState extends EnumSchema {
    id: string;
    key: string;
    savedValues: EnumValueSchema[];
    selectedValueIndex?: number;
}

type Selection = { kind: 'table' | 'constant' | 'structure' | 'enum'; id: string };
type EnumResolver = (enumKey: string) => EnumState | undefined;
type ResourceKind = Selection['kind'];
type SaveValidationTarget =
    | { kind: 'table'; table: CsvTableState }
    | { kind: 'constant'; constant: ConstantState }
    | { kind: 'structure'; structure: StructureState }
    | { kind: 'enum'; enumSchema: EnumState }
    | { kind: 'none' };
type SelectionSnapshot =
    | {
        kind: 'table';
        moduleKey: string;
        path: string;
        activeTab: TableTab;
        selectedFieldIndex?: number;
        selectedRowIndex?: number;
    }
    | {
        kind: 'constant';
        moduleKey: string;
        path: string;
    }
    | {
        kind: 'structure';
        key: string;
        selectedFieldIndex?: number;
    }
    | {
        kind: 'enum';
        key: string;
        selectedValueIndex?: number;
    };

export interface ConfigRepository {
    load(): Promise<ConfigToolPayload>;
    save(request: ConfigToolSaveRequest): Promise<ConfigToolPayload>;
    generateCode?(options?: ConfigToolCodegenRequestOptions): Promise<ConfigToolCodegenResult>;
}

export interface ConfigToolOptions {
    container: HTMLElement;
    path?: string;
    codegen?: boolean | ConfigToolCodegenRequestOptions;
}

export interface ConfigToolCodegenRequestOptions {
    inputRoot?: string;
    outputRoot?: string;
    outputFile?: string;
    repositoryName?: string;
    staticBaseUrl?: string;
}

export interface ConfigToolCodegenResult {
    inputRoot: string;
    outputRoot: string;
    files: string[];
}

export interface ConfigToolHandle {
    load(): Promise<void>;
    refresh(): Promise<void>;
    destroy(): void;
}

export type MountConfigToolOptions = Omit<ConfigToolOptions, 'container'>;

export interface HttpConfigRepositoryOptions {
    apiBaseUrl?: string;
    staticBaseUrl?: string;
    codegen?: ConfigToolCodegenRequestOptions;
}

export interface StaticConfigRepositoryOptions {
    staticBaseUrl?: string;
}

let nextGeneratedId = 1;

export function newConfigTool(options: ConfigToolOptions): ConfigToolHandle {
    const codegenOptions = normalizeCodegenOptions(options.codegen);
    const repository = createHttpConfigRepository({
        staticBaseUrl: options.path,
        codegen: codegenOptions
    });
    const tool = new ConfigTool(options.container, repository, options.codegen !== undefined && options.codegen !== false);
    return {
        load: () => tool.load(),
        refresh: () => tool.load(),
        destroy: () => tool.destroy()
    };
}

function createHttpConfigRepository(options: HttpConfigRepositoryOptions = {}): ConfigRepository {
    const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_CONFIG_API_BASE_URL;
    const readonlyRepository = createReadonlyStaticConfigRepository({ staticBaseUrl: options.staticBaseUrl });
    return {
        async load() {
            try {
                return await fetchConfigPayload(joinUrl(apiBaseUrl, 'config'));
            } catch {
                return await readonlyRepository.load();
            }
        },
        async save(request) {
            return await postConfigPayload(joinUrl(apiBaseUrl, 'save'), request);
        },
        async generateCode() {
            return await postCodegenRequest(joinUrl(apiBaseUrl, 'generate'), options.codegen ?? {});
        }
    };
}

function createReadonlyStaticConfigRepository(options: StaticConfigRepositoryOptions = {}): ConfigRepository {
    const staticBaseUrl = options.staticBaseUrl ?? DEFAULT_STATIC_CONFIG_BASE_URL;
    return {
        load: () => loadStaticPayload(staticBaseUrl),
        async save() {
            throw new Error('Readonly config repository cannot save.');
        },
        async generateCode() {
            throw new Error('Readonly config repository cannot generate code.');
        }
    };
}

function normalizeCodegenOptions(options: boolean | ConfigToolCodegenRequestOptions | undefined): ConfigToolCodegenRequestOptions | undefined {
    if (options === undefined || options === false) {
        return undefined;
    }
    if (options === true) {
        return {};
    }
    return options;
}

class ConfigTool {
    private manifest: Manifest = { modules: {} };
    private schema: ConfigSchema = { version: 1, tables: {}, constants: {}, structures: {}, enums: {} };
    private tables: CsvTableState[] = [];
    private constants: ConstantState[] = [];
    private structures: StructureState[] = [];
    private enums: EnumState[] = [];
    private deletedPaths = new Set<string>();
    private selected?: Selection;
    private activeKind: ResourceKind = 'table';
    private writable = false;
    private loading = true;
    private status = '正在加载配置。';

    constructor(
        private readonly container: HTMLElement,
        private readonly repository: ConfigRepository,
        private readonly codegenEnabled: boolean
    ) {
        this.render();
    }

    async load(): Promise<void> {
        this.loading = true;
        this.status = '正在加载配置。';
        this.render();

        try {
            const payload = await this.repository.load();
            this.applyPayload(payload);
            this.status = payload.writable ? '已连接开发保存接口。' : '只读模式。';
        } catch (error) {
            this.writable = false;
            this.status = `加载失败：${errorMessage(error)}`;
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private applyPayload(payload: ConfigToolPayload): void {
        this.manifest = payload.manifest;
        this.schema = normalizeSchema(payload.schema);
        this.writable = payload.writable;
        this.tables = payload.tables.map((table) => {
            const fields = ensureRequiredFields(table.fields);
            const rows = table.rows.map((row) => withFieldDefaults(row, fields));
            return {
                ...table,
                fields,
                rows,
                id: createId('table', table.moduleKey),
                originalPath: table.path,
                activeTab: 'schema' as TableTab,
                savedModuleKey: table.moduleKey,
                savedFields: fields.map(cloneFieldSchema),
                savedRows: rows.map(cloneRow),
                selectedFieldIndex: undefined,
                selectedRowIndex: undefined
            };
        });
        this.constants = payload.constants.map((constant) => ({
            ...constant,
            id: createId('constant', constant.moduleKey),
            originalPath: constant.path,
            savedModuleKey: constant.moduleKey,
            savedDescription: constant.description,
            savedText: constant.text
        }));
        this.structures = Object.entries(this.schema.structures).map(([key, structure]) => ({
            ...structure,
            key,
            fields: structure.fields.map(cloneStructureFieldSchema),
            id: createId('structure', key),
            savedFields: structure.fields.map(cloneStructureFieldSchema),
            selectedFieldIndex: undefined
        }));
        this.enums = Object.entries(this.schema.enums).map(([key, enumSchema]) => ({
            ...enumSchema,
            key,
            values: enumSchema.values.map(cloneEnumValueSchema),
            id: createId('enum', key),
            savedValues: enumSchema.values.map(cloneEnumValueSchema),
            selectedValueIndex: undefined
        }));
        this.deletedPaths.clear();
        this.ensureSelection();
    }

    private ensureSelection(): void {
        if (this.selected?.kind === 'table' && this.tables.some((table) => table.id === this.selected?.id)) {
            this.activeKind = 'table';
            return;
        }
        if (this.selected?.kind === 'constant' && this.constants.some((constant) => constant.id === this.selected?.id)) {
            this.activeKind = 'constant';
            return;
        }
        if (this.selected?.kind === 'structure' && this.structures.some((structure) => structure.id === this.selected?.id)) {
            this.activeKind = 'structure';
            return;
        }
        if (this.selected?.kind === 'enum' && this.enums.some((enumSchema) => enumSchema.id === this.selected?.id)) {
            this.activeKind = 'enum';
            return;
        }
        const activeItem = this.itemsForKind(this.activeKind)[0];
        if (activeItem) {
            this.selected = { kind: this.activeKind, id: activeItem.id };
            return;
        }
        const firstTable = this.tables[0];
        if (firstTable) {
            this.activeKind = 'table';
            this.selected = { kind: 'table', id: firstTable.id };
            return;
        }
        const firstConstant = this.constants[0];
        if (firstConstant) {
            this.activeKind = 'constant';
            this.selected = { kind: 'constant', id: firstConstant.id };
            return;
        }
        const firstStructure = this.structures[0];
        if (firstStructure) {
            this.activeKind = 'structure';
            this.selected = { kind: 'structure', id: firstStructure.id };
            return;
        }
        const firstEnum = this.enums[0];
        this.activeKind = firstEnum ? 'enum' : this.activeKind;
        this.selected = firstEnum ? { kind: 'enum', id: firstEnum.id } : undefined;
    }

    private render(): void {
        this.container.replaceChildren(this.createView());
    }

    private scheduleRender(): void {
        window.setTimeout(() => this.render(), 0);
    }

    private createView(): HTMLElement {
        const shell = element('main', 'config-tool');
        shell.append(this.createHeader(), this.createBody());
        return shell;
    }

    private createHeader(): HTMLElement {
        const header = element('header', 'config-tool__header');
        const titleBlock = element('div', 'config-tool__title-block');
        titleBlock.append(
            element('h1', 'config-tool__title', '配置工具'),
            element('p', 'config-tool__summary', this.status)
        );

        const actions = element('div', 'config-tool__actions');
        const reloadButton = button('重新加载', 'button button--secondary button--header', () => void this.load());
        reloadButton.disabled = this.loading;
        actions.append(reloadButton);
        if (this.codegenEnabled) {
            const codegenButton = button('生成代码', 'button button--secondary button--header', () => void this.generateCode());
            codegenButton.disabled = this.loading || !this.writable;
            actions.append(codegenButton);
        }
        actions.append(link('开发菜单', '/dev'));
        header.append(titleBlock, actions);
        return header;
    }

    private createBody(): HTMLElement {
        const body = element('section', 'config-tool__body');
        const content = element('div', 'config-tool__content');
        content.append(this.createSidebar(), this.createWorkspace());
        body.append(this.createSectionTabs(), content);
        return body;
    }

    private createSectionTabs(): HTMLElement {
        const tabs = element('nav', 'config-section-tabs');
        this.sectionDefinitions().forEach((section) => {
            const tab = button(section.title, this.activeKind === section.kind ? 'config-section-tab config-section-tab--active' : 'config-section-tab', () => {
                this.activeKind = section.kind;
                this.selectFirstItemInKind(section.kind);
                this.render();
            });
            tabs.append(tab);
        });
        return tabs;
    }

    private createSidebar(): HTMLElement {
        const sidebar = element('aside', 'config-tool__sidebar');
        const section = this.sectionDefinitions().find((item) => item.kind === this.activeKind) ?? this.sectionDefinitions()[0];
        sidebar.append(this.createSidebarSection(section.title, section.actionText, section.action, section.items, section.kind));
        return sidebar;
    }

    private sectionDefinitions(): Array<{
        kind: ResourceKind;
        title: string;
        actionText: string;
        action: () => void;
        items: Array<CsvTableState | ConstantState | StructureState | EnumState>;
    }> {
        return [
            { kind: 'table', title: 'CSV 表格', actionText: '新建', action: () => this.addTable(), items: this.tables },
            { kind: 'constant', title: '常量 JSON', actionText: '新建', action: () => this.addConstant(), items: this.constants },
            { kind: 'structure', title: '自定义结构', actionText: '新建', action: () => this.addStructure(), items: this.structures },
            { kind: 'enum', title: '自定义枚举', actionText: '新建', action: () => this.addEnum(), items: this.enums }
        ];
    }

    private createSidebarSection(
        title: string,
        actionText: string,
        action: () => void,
        items: Array<CsvTableState | ConstantState | StructureState | EnumState>,
        kind: Selection['kind']
    ): HTMLElement {
        const section = element('section', 'config-nav');
        const header = element('div', 'config-nav__header');
        header.append(element('h2', 'config-nav__title', title), button(actionText, 'button button--ghost config-nav__add', action));
        const list = element('div', 'config-nav__list');

        if (items.length === 0) {
            list.append(element('div', 'config-nav__empty', '暂无配置。'));
        }

        items.forEach((item) => {
            const active = this.selected?.kind === kind && this.selected.id === item.id;
            const itemButton = element('button', active ? 'config-nav__item config-nav__item--active' : 'config-nav__item') as HTMLButtonElement;
            itemButton.type = 'button';
            itemButton.addEventListener('click', () => {
                this.activeKind = kind;
                this.selected = { kind, id: item.id };
                this.render();
            });
            itemButton.append(
                element('span', 'config-nav__key', navItemTitle(item)),
                element('span', 'config-nav__path', navItemMeta(item))
            );
            list.append(itemButton);
        });

        section.append(header, list);
        return section;
    }

    private createWorkspace(): HTMLElement {
        const table = this.selected?.kind === 'table' ? this.tables.find((item) => item.id === this.selected?.id) : undefined;
        if (table) {
            return this.createTableEditor(table);
        }

        const constant = this.selected?.kind === 'constant' ? this.constants.find((item) => item.id === this.selected?.id) : undefined;
        if (constant) {
            return this.createConstantEditor(constant);
        }

        const structure = this.selected?.kind === 'structure' ? this.structures.find((item) => item.id === this.selected?.id) : undefined;
        if (structure) {
            return this.createStructureEditor(structure);
        }

        const enumSchema = this.selected?.kind === 'enum' ? this.enums.find((item) => item.id === this.selected?.id) : undefined;
        if (enumSchema) {
            return this.createEnumEditor(enumSchema);
        }

        const empty = element('section', 'config-workspace');
        empty.append(element('div', 'empty-state', '选择或新建一个配置项。'));
        return empty;
    }

    private createTableEditor(table: CsvTableState): HTMLElement {
        const workspace = element('section', 'config-workspace');
        workspace.append(this.createTableHeader(table));
        workspace.append(this.createTableTabs(table));

        if (table.activeTab === 'schema') {
            workspace.append(this.createFieldEditor(table));
        } else {
            workspace.append(this.createDataEditor(table));
        }
        return workspace;
    }

    private createTableTabs(table: CsvTableState): HTMLElement {
        const tabs = element('div', 'config-tabs');
        tabs.append(
            this.createTableTabButton(table, 'schema', '结构定义'),
            this.createTableTabButton(table, 'data', '数据编辑')
        );
        return tabs;
    }

    private createTableTabButton(table: CsvTableState, tab: TableTab, text: string): HTMLButtonElement {
        const tabButton = button(text, table.activeTab === tab ? 'config-tab config-tab--active' : 'config-tab', () => {
            table.activeTab = tab;
            if (tab === 'schema' && table.selectedFieldIndex !== undefined && !table.fields[table.selectedFieldIndex]) {
                table.selectedFieldIndex = undefined;
            }
            if (tab === 'data' && table.selectedRowIndex !== undefined && !table.rows[table.selectedRowIndex]) {
                table.selectedRowIndex = undefined;
            }
            this.render();
        });
        return tabButton;
    }

    private createConstantEditor(constant: ConstantState): HTMLElement {
        const workspace = element('section', 'config-workspace');
        workspace.append(
            this.createConstantHeader(constant),
            this.createJsonEditor(constant)
        );
        return workspace;
    }

    private createStructureEditor(structure: StructureState): HTMLElement {
        const workspace = element('section', 'config-workspace');
        workspace.append(
            this.createStructureHeader(structure),
            this.createStructureFieldEditor(structure)
        );
        return workspace;
    }

    private createEnumEditor(enumSchema: EnumState): HTMLElement {
        const workspace = element('section', 'config-workspace');
        workspace.append(
            this.createEnumHeader(enumSchema),
            this.createEnumValueEditor(enumSchema)
        );
        return workspace;
    }

    private createTableHeader(table: CsvTableState): HTMLElement {
        const moduleField = this.createTextField('\u6a21\u5757 key', table.moduleKey, (value) => {
            table.moduleKey = value.trim();
            table.path = pathForModuleKey(table.moduleKey, '.csv');
        }, () => this.render());
        return this.createDefinitionHeader(
            '\u7ed3\u6784\u5316\u6570\u636e\u8868',
            [moduleField],
            () => void this.save('\u8868\u5b9a\u4e49\u5df2\u4fdd\u5b58\u3002', { kind: 'table', table }),
            () => void this.deleteTable(table)
        );
    }

    private createConstantHeader(constant: ConstantState): HTMLElement {
        const moduleField = this.createTextField('\u6a21\u5757 key', constant.moduleKey, (value) => {
            constant.moduleKey = value.trim();
            constant.path = pathForModuleKey(constant.moduleKey, '.json');
        }, () => this.render());
        const descriptionField = this.createTextField('\u63cf\u8ff0', constant.description, (value) => {
            constant.description = value;
        });
        return this.createDefinitionHeader(
            '\u5e38\u91cf\u8868',
            [moduleField, descriptionField],
            () => void this.save('JSON \u5b9a\u4e49\u5df2\u4fdd\u5b58\u3002', { kind: 'constant', constant }),
            () => void this.deleteConstant(constant)
        );
    }

    private createStructureHeader(structure: StructureState): HTMLElement {
        const keyField = this.createTextField('\u7ed3\u6784 key', structure.key, (value) => {
            this.renameStructureKey(structure, value.trim());
        }, () => this.render());
        const descriptionField = this.createTextField('\u63cf\u8ff0', structure.description, (value) => {
            structure.description = value;
        });
        return this.createDefinitionHeader(
            '\u81ea\u5b9a\u4e49\u7ed3\u6784',
            [keyField, descriptionField],
            () => void this.save('\u7ed3\u6784\u5b9a\u4e49\u5df2\u4fdd\u5b58\u3002', { kind: 'structure', structure }),
            () => void this.deleteStructure(structure)
        );
    }

    private createEnumHeader(enumSchema: EnumState): HTMLElement {
        const keyField = this.createTextField('\u679a\u4e3e key', enumSchema.key, (value) => {
            this.renameEnumKey(enumSchema, value.trim());
        }, () => this.render());
        const descriptionField = this.createTextField('\u63cf\u8ff0', enumSchema.description, (value) => {
            enumSchema.description = value;
        });
        return this.createDefinitionHeader(
            '\u81ea\u5b9a\u4e49\u679a\u4e3e',
            [keyField, descriptionField],
            () => void this.save('\u679a\u4e3e\u5b9a\u4e49\u5df2\u4fdd\u5b58\u3002', { kind: 'enum', enumSchema }),
            () => void this.deleteEnum(enumSchema)
        );
    }

    private createDefinitionHeader(title: string, fields: HTMLElement[], onSave: () => void, onDelete: () => void): HTMLElement {
        const header = element('div', 'config-editor__header config-editor__header--definition');
        const titleBlock = element('div', 'config-editor__title-block');
        const fieldGroup = element('div', 'config-editor__fields');
        fields.forEach((field) => {
            field.classList.add('config-field--inline');
            fieldGroup.append(field);
        });
        titleBlock.append(element('h2', 'config-editor__title', title), fieldGroup);

        const actions = element('div', 'config-editor__actions');
        actions.append(
            button('\u4fdd\u5b58', 'button button--primary button--header', onSave),
            button('\u5220\u9664', 'button button--ghost config-editor__delete', onDelete)
        );
        header.append(titleBlock, actions);
        return header;
    }

    private createTextField(labelText: string, value: string, onInput: (value: string) => void, onChange?: () => void): HTMLElement {
        const label = element('label', 'config-field');
        const input = element('input', 'config-field__input') as HTMLInputElement;
        input.value = value;
        input.addEventListener('input', () => onInput(input.value));
        if (onChange) {
            input.addEventListener('change', onChange);
        }
        label.append(element('span', 'config-field__label', labelText), input);
        return label;
    }

    private createRowNavActions(actions: HTMLButtonElement[]): HTMLElement {
        const wrapper = element('div', 'config-row-nav__actions');
        wrapper.append(...actions);
        return wrapper;
    }

    private createRowNavToolbar(actions: HTMLButtonElement[]): HTMLElement {
        const toolbar = element('div', 'config-row-nav__toolbar');
        toolbar.append(...actions);
        return toolbar;
    }

    private createMoveButton(text: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
        const node = button(text, 'button button--ghost config-row-nav__move', onClick);
        node.disabled = disabled;
        return node;
    }

    private createFieldEditor(table: CsvTableState): HTMLElement {
        this.ensureTableFieldSelection(table);
        const panel = element('section', 'config-panel config-panel--data');
        const header = element('div', 'config-panel__header');
        header.append(element('h3', 'config-panel__title', `字段 · ${table.fields.length}`));
        panel.append(header);

        const editor = element('div', 'config-data-editor');
        editor.append(
            this.createFieldList(table),
            this.createFieldWorkspace(table),
            this.createOverviewColumn('完整结构', this.createReadonlyFieldsTable(table))
        );
        panel.append(editor);
        return panel;
    }

    private createFieldList(table: CsvTableState): HTMLElement {
        const sidebar = element('aside', 'config-row-nav');
        const list = element('div', 'config-row-nav__list');
        table.fields.forEach((field, fieldIndex) => {
            const item = element('div', 'config-row-nav__item');
            const dirty = this.isTableFieldDirty(table, fieldIndex);
            const fieldButton = element('button', navSelectClass(table.selectedFieldIndex === fieldIndex, dirty)) as HTMLButtonElement;
            fieldButton.type = 'button';
            fieldButton.textContent = fieldLabel(field, fieldIndex);
            fieldButton.title = dirty ? '未保存修改' : '';
            fieldButton.addEventListener('click', () => {
                table.selectedFieldIndex = fieldIndex;
                this.render();
            });
            item.append(fieldButton);
            if (!isRequiredField(field.key)) {
                item.append(this.createRowNavActions([
                    this.createMoveButton('上移', !this.canMoveField(table, fieldIndex, -1), () => this.moveField(table, fieldIndex, -1)),
                    this.createMoveButton('下移', !this.canMoveField(table, fieldIndex, 1), () => this.moveField(table, fieldIndex, 1)),
                    button('删除', 'button button--ghost config-row-nav__delete', () => void this.removeField(table, field))
                ]));
            }
            list.append(item);
        });

        sidebar.append(
            this.createRowNavToolbar([
                button('新增', 'button button--secondary config-row-nav__add', () => this.addField(table)),
                button('保存', 'button button--primary config-row-nav__save', () => void this.save('字段定义已保存。', { kind: 'table', table }))
            ]),
            list
        );
        return sidebar;
    }

    private createFieldWorkspace(table: CsvTableState): HTMLElement {
        const selectedField = table.selectedFieldIndex === undefined ? undefined : table.fields[table.selectedFieldIndex];
        const workspace = element('div', 'config-row-workspace');
        if (!selectedField) {
            workspace.append(element('div', 'empty-state', '选择左侧字段进行编辑。'));
            return workspace;
        }

        workspace.append(this.createFieldDetailEditor(table, selectedField, table.selectedFieldIndex ?? 0));
        return workspace;
    }

    private createReadonlyFieldsTable(table: CsvTableState): HTMLElement {
        const scroll = element('div', 'config-data-scroll');
        const dataTable = element('table', 'config-data-table');
        const thead = element('thead');
        const headRow = element('tr');
        ['#', 'key', '类型', '描述'].forEach((title) => headRow.append(element('th', '', title)));
        thead.append(headRow);

        const tbody = element('tbody');
        if (table.savedFields.length === 0) {
            const emptyRow = element('tr');
            const emptyCell = element('td', 'config-data-table__empty', '暂无已保存字段。') as HTMLTableCellElement;
            emptyCell.colSpan = 4;
            emptyRow.append(emptyCell);
            tbody.append(emptyRow);
        }
        table.savedFields.forEach((field, fieldIndex) => {
            const row = element('tr');
            row.append(
                element('td', 'config-data-table__index', String(fieldIndex + 1)),
                element('td', '', field.key),
                element('td', '', this.readonlyFieldTypeLabel(field)),
                element('td', '', field.description)
            );
            tbody.append(row);
        });

        dataTable.append(thead, tbody);
        scroll.append(dataTable);
        return scroll;
    }

    private createFieldDetailEditor(table: CsvTableState, field: FieldSchema, fieldIndex: number): HTMLElement {
        const editor = element('section', 'config-row-editor');
        const header = element('div', 'config-row-editor__header');
        const title = element('h3', 'config-row-editor__title', fieldLabel(field, fieldIndex));
        if (isRequiredField(field.key)) {
            title.append(element('span', 'config-required-mark', '*'));
        }
        header.append(title);

        const fieldControls = [
            this.createEditorFormField('key', '', this.createFieldKeyInput(table, field)),
            this.createEditorFormField('类型', '', this.createFieldTypeControl(field)),
            this.createEditorFormField('描述', '', this.createFieldDescriptionInput(field))
        ];
        if (baseFieldType(field.type) === 'number' && !isRequiredField(field.key)) {
            fieldControls.splice(2, 0, this.createEditorFormField('约束', '', this.createNumberConstraintEditor(field)));
        }
        if (isStructuredField(field)) {
            fieldControls.splice(2, 0, this.createEditorFormField('结构', '', this.createFieldStructureSelect(field)));
        }

        const fields = element('div', 'config-row-fields');
        fields.append(...fieldControls);
        editor.append(header, fields);
        return editor;
    }

    private createStructureFieldEditor(structure: StructureState): HTMLElement {
        this.ensureStructureFieldSelection(structure);
        const panel = element('section', 'config-panel config-panel--data');
        const header = element('div', 'config-panel__header');
        header.append(element('h3', 'config-panel__title', `结构字段 · ${structure.fields.length}`));
        panel.append(header);

        const editor = element('div', 'config-data-editor');
        editor.append(
            this.createStructureFieldList(structure),
            this.createStructureFieldWorkspace(structure),
            this.createOverviewColumn('完整结构', this.createReadonlyStructureFieldsTable(structure))
        );
        panel.append(editor);
        return panel;
    }

    private createStructureFieldList(structure: StructureState): HTMLElement {
        const sidebar = element('aside', 'config-row-nav');
        const list = element('div', 'config-row-nav__list');
        if (structure.fields.length === 0) {
            list.append(element('div', 'config-row-nav__empty', '暂无结构字段。'));
        }
        structure.fields.forEach((field, fieldIndex) => {
            const item = element('div', 'config-row-nav__item');
            const dirty = this.isStructureFieldDirty(structure, fieldIndex);
            const fieldButton = element('button', navSelectClass(structure.selectedFieldIndex === fieldIndex, dirty)) as HTMLButtonElement;
            fieldButton.type = 'button';
            fieldButton.textContent = structureFieldLabel(field, fieldIndex);
            fieldButton.title = dirty ? '未保存修改' : '';
            fieldButton.addEventListener('click', () => {
                structure.selectedFieldIndex = fieldIndex;
                this.render();
            });
            item.append(fieldButton, this.createRowNavActions([
                this.createMoveButton('上移', fieldIndex === 0, () => this.moveStructureField(structure, fieldIndex, -1)),
                this.createMoveButton('下移', fieldIndex === structure.fields.length - 1, () => this.moveStructureField(structure, fieldIndex, 1)),
                button('删除', 'button button--ghost config-row-nav__delete', () => void this.removeStructureField(structure, field))
            ]));
            list.append(item);
        });

        sidebar.append(
            this.createRowNavToolbar([
                button('新增', 'button button--secondary config-row-nav__add', () => this.addStructureField(structure)),
                button('保存', 'button button--primary config-row-nav__save', () => void this.save('结构字段已保存。', { kind: 'structure', structure }))
            ]),
            list
        );
        return sidebar;
    }

    private createStructureFieldWorkspace(structure: StructureState): HTMLElement {
        const selectedField = structure.selectedFieldIndex === undefined ? undefined : structure.fields[structure.selectedFieldIndex];
        const workspace = element('div', 'config-row-workspace');
        if (!selectedField) {
            workspace.append(element('div', 'empty-state', '选择左侧字段进行编辑。'));
            return workspace;
        }

        workspace.append(this.createStructureFieldDetailEditor(structure, selectedField, structure.selectedFieldIndex ?? 0));
        return workspace;
    }

    private createReadonlyStructureFieldsTable(structure: StructureState): HTMLElement {
        const scroll = element('div', 'config-data-scroll');
        const dataTable = element('table', 'config-data-table');
        const thead = element('thead');
        const headRow = element('tr');
        ['#', 'key', '类型', '描述'].forEach((title) => headRow.append(element('th', '', title)));
        thead.append(headRow);

        const tbody = element('tbody');
        if (structure.savedFields.length === 0) {
            const emptyRow = element('tr');
            const emptyCell = element('td', 'config-data-table__empty', '暂无结构字段。') as HTMLTableCellElement;
            emptyCell.colSpan = 4;
            emptyRow.append(emptyCell);
            tbody.append(emptyRow);
        }
        structure.savedFields.forEach((field, fieldIndex) => {
            const row = element('tr');
            row.append(
                element('td', 'config-data-table__index', String(fieldIndex + 1)),
                element('td', '', field.key),
                element('td', '', field.type),
                element('td', '', field.description)
            );
            tbody.append(row);
        });

        dataTable.append(thead, tbody);
        scroll.append(dataTable);
        return scroll;
    }

    private createStructureFieldDetailEditor(structure: StructureState, field: StructureFieldSchema, fieldIndex: number): HTMLElement {
        const editor = element('section', 'config-row-editor');
        const header = element('div', 'config-row-editor__header');
        header.append(element('h3', 'config-row-editor__title', structureFieldLabel(field, fieldIndex)));

        const fields = element('div', 'config-row-fields');
        const fieldControls = [
            this.createEditorFormField('key', '', this.createStructureFieldKeyInput(structure, field)),
            this.createEditorFormField('类型', '', this.createStructureFieldTypeControl(field)),
            this.createEditorFormField('描述', '', this.createStructureFieldDescriptionInput(field))
        ];
        if (baseFieldType(field.type) === 'number') {
            fieldControls.splice(2, 0, this.createEditorFormField('约束', '', this.createNumberConstraintEditor(field)));
        }
        fields.append(...fieldControls);

        editor.append(header, fields);
        return editor;
    }

    private createEnumValueEditor(enumSchema: EnumState): HTMLElement {
        this.sortEnumStateValues(enumSchema);
        this.ensureEnumValueSelection(enumSchema);
        const panel = element('section', 'config-panel config-panel--data');
        const header = element('div', 'config-panel__header');
        header.append(element('h3', 'config-panel__title', `枚举值 · ${enumSchema.values.length}`));
        panel.append(header);

        const editor = element('div', 'config-data-editor');
        editor.append(
            this.createEnumValueList(enumSchema),
            this.createEnumValueWorkspace(enumSchema),
            this.createOverviewColumn('完整枚举', this.createReadonlyEnumValuesTable(enumSchema))
        );
        panel.append(editor);
        return panel;
    }

    private createEnumValueList(enumSchema: EnumState): HTMLElement {
        const sidebar = element('aside', 'config-row-nav');
        const list = element('div', 'config-row-nav__list');
        if (enumSchema.values.length === 0) {
            list.append(element('div', 'config-row-nav__empty', '暂无枚举值。'));
        }
        enumSchema.values.forEach((enumValue, valueIndex) => {
            const item = element('div', 'config-row-nav__item');
            const dirty = this.isEnumValueDirty(enumSchema, valueIndex);
            const valueButton = element('button', navSelectClass(enumSchema.selectedValueIndex === valueIndex, dirty)) as HTMLButtonElement;
            valueButton.type = 'button';
            valueButton.textContent = enumValueLabel(enumValue, valueIndex);
            valueButton.title = dirty ? '未保存修改' : '';
            valueButton.addEventListener('click', () => {
                enumSchema.selectedValueIndex = valueIndex;
                this.render();
            });
            item.append(valueButton, this.createRowNavActions([
                button('删除', 'button button--ghost config-row-nav__delete', () => void this.removeEnumValue(enumSchema, enumValue))
            ]));
            list.append(item);
        });

        sidebar.append(
            this.createRowNavToolbar([
                button('新增', 'button button--secondary config-row-nav__add', () => this.addEnumValue(enumSchema)),
                button('保存', 'button button--primary config-row-nav__save', () => void this.save('枚举值已保存。', { kind: 'enum', enumSchema }))
            ]),
            list
        );
        return sidebar;
    }

    private createEnumValueWorkspace(enumSchema: EnumState): HTMLElement {
        const selectedValue = enumSchema.selectedValueIndex === undefined ? undefined : enumSchema.values[enumSchema.selectedValueIndex];
        const workspace = element('div', 'config-row-workspace');
        if (!selectedValue) {
            workspace.append(element('div', 'empty-state', '选择左侧枚举值进行编辑。'));
            return workspace;
        }

        workspace.append(this.createEnumValueDetailEditor(enumSchema, selectedValue, enumSchema.selectedValueIndex ?? 0));
        return workspace;
    }

    private createReadonlyEnumValuesTable(enumSchema: EnumState): HTMLElement {
        const scroll = element('div', 'config-data-scroll');
        const dataTable = element('table', 'config-data-table');
        const thead = element('thead');
        const headRow = element('tr');
        ['#', 'key', 'value', 'desc'].forEach((title) => headRow.append(element('th', '', title)));
        thead.append(headRow);

        const tbody = element('tbody');
        if (enumSchema.savedValues.length === 0) {
            const emptyRow = element('tr');
            const emptyCell = element('td', 'config-data-table__empty', '暂无枚举值。') as HTMLTableCellElement;
            emptyCell.colSpan = 4;
            emptyRow.append(emptyCell);
            tbody.append(emptyRow);
        }
        enumSchema.savedValues.forEach((enumValue, valueIndex) => {
            const row = element('tr');
            row.append(
                element('td', 'config-data-table__index', String(valueIndex + 1)),
                element('td', '', enumValue.key),
                element('td', '', String(enumValue.value)),
                element('td', '', enumValue.description)
            );
            tbody.append(row);
        });

        dataTable.append(thead, tbody);
        scroll.append(dataTable);
        return scroll;
    }

    private createEnumValueDetailEditor(enumSchema: EnumState, enumValue: EnumValueSchema, valueIndex: number): HTMLElement {
        const editor = element('section', 'config-row-editor');
        const header = element('div', 'config-row-editor__header');
        header.append(element('h3', 'config-row-editor__title', enumValueLabel(enumValue, valueIndex)));

        const fields = element('div', 'config-row-fields');
        fields.append(
            this.createEditorFormField('key', '', this.createEnumValueKeyInput(enumSchema, enumValue)),
            this.createEditorFormField('value', '', this.createEnumValueNumberInput(enumSchema, enumValue)),
            this.createEditorFormField('desc', '', this.createEnumValueDescriptionInput(enumValue))
        );

        editor.append(header, fields);
        return editor;
    }

    private createEditorFormField(labelText: string, metaText: string, control: HTMLElement): HTMLElement {
        const fieldWrapper = element('div', 'config-row-field');
        const label = element('span', 'config-row-field__label', labelText);
        fieldWrapper.append(label);
        if (metaText) {
            fieldWrapper.append(element('span', 'config-row-field__meta', metaText));
        }
        fieldWrapper.append(control);
        return fieldWrapper;
    }

    private createOverviewColumn(title: string, content: HTMLElement): HTMLElement {
        const wrapper = element('section', 'config-overview');
        wrapper.append(element('h3', 'config-overview__title', title), content);
        return wrapper;
    }

    private ensureTableFieldSelection(table: CsvTableState): void {
        if (table.fields.length === 0) {
            table.selectedFieldIndex = undefined;
            return;
        }
        if (table.selectedFieldIndex === undefined || !table.fields[table.selectedFieldIndex]) {
            table.selectedFieldIndex = 0;
        }
    }

    private ensureStructureFieldSelection(structure: StructureState): void {
        if (structure.fields.length === 0) {
            structure.selectedFieldIndex = undefined;
            return;
        }
        if (structure.selectedFieldIndex === undefined || !structure.fields[structure.selectedFieldIndex]) {
            structure.selectedFieldIndex = 0;
        }
    }

    private ensureEnumValueSelection(enumSchema: EnumState): void {
        if (enumSchema.values.length === 0) {
            enumSchema.selectedValueIndex = undefined;
            return;
        }
        if (enumSchema.selectedValueIndex === undefined || !enumSchema.values[enumSchema.selectedValueIndex]) {
            enumSchema.selectedValueIndex = 0;
        }
    }

    private ensureTableRowSelection(table: CsvTableState): void {
        if (table.rows.length === 0) {
            table.selectedRowIndex = undefined;
            return;
        }
        if (table.selectedRowIndex === undefined || !table.rows[table.selectedRowIndex]) {
            table.selectedRowIndex = 0;
        }
    }

    private isTableFieldDirty(table: CsvTableState, fieldIndex: number): boolean {
        const field = table.fields[fieldIndex];
        const savedField = table.savedFields[fieldIndex];
        return !field || !savedField || !sameFieldSchema(field, savedField);
    }

    private isStructureFieldDirty(structure: StructureState, fieldIndex: number): boolean {
        const field = structure.fields[fieldIndex];
        const savedField = structure.savedFields[fieldIndex];
        return !field || !savedField || !sameStructureFieldSchema(field, savedField);
    }

    private isEnumValueDirty(enumSchema: EnumState, valueIndex: number): boolean {
        const enumValue = enumSchema.values[valueIndex];
        const savedValue = enumSchema.savedValues[valueIndex];
        return !enumValue || !savedValue || !sameEnumValueSchema(enumValue, savedValue);
    }

    private isTableRowDirty(table: CsvTableState, rowIndex: number): boolean {
        const row = table.rows[rowIndex];
        const savedRow = table.savedRows[rowIndex];
        if (!row || !savedRow) {
            return true;
        }

        const savedFieldKeys = new Set(table.savedFields.map((field) => field.key));
        return table.fields
            .filter((field) => savedFieldKeys.has(field.key))
            .some((field) => (row[field.key] ?? '') !== (savedRow[field.key] ?? ''));
    }

    private hasUnsavedChanges(): boolean {
        return this.tables.length !== Object.keys(this.schema.tables).length
            || this.constants.length !== Object.keys(this.schema.constants).length
            || this.structures.length !== Object.keys(this.schema.structures).length
            || this.enums.length !== Object.keys(this.schema.enums).length
            || this.tables.some((table) => !table.savedModuleKey
                || this.hasUnsavedTableDefinition(table)
                || table.rows.length !== table.savedRows.length
                || table.rows.some((_, rowIndex) => this.isTableRowDirty(table, rowIndex)))
            || this.constants.some((constant) => !constant.savedModuleKey
                || constant.moduleKey !== constant.savedModuleKey
                || constant.description !== constant.savedDescription
                || constant.text !== constant.savedText)
            || this.structures.some((structure) => this.isStructureDirty(structure))
            || this.enums.some((enumSchema) => this.isEnumDirty(enumSchema));
    }

    private isStructureDirty(structure: StructureState): boolean {
        const savedStructure = this.schema.structures[structure.key];
        return !savedStructure
            || structure.description !== savedStructure.description
            || structure.fields.length !== savedStructure.fields.length
            || structure.fields.some((field, fieldIndex) => !sameStructureFieldSchema(field, savedStructure.fields[fieldIndex]));
    }

    private isEnumDirty(enumSchema: EnumState): boolean {
        const savedEnum = this.schema.enums[enumSchema.key];
        return !savedEnum
            || enumSchema.description !== savedEnum.description
            || enumSchema.values.length !== savedEnum.values.length
            || enumSchema.values.some((enumValue, valueIndex) => !sameEnumValueSchema(enumValue, savedEnum.values[valueIndex]));
    }

    private createFieldKeyInput(table: CsvTableState, field: FieldSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.value = field.key;
        input.placeholder = 'field_key';
        input.disabled = isRequiredField(field.key);
        input.addEventListener('change', () => {
            this.renameField(table, field, input.value.trim());
            this.scheduleRender();
        });
        return input;
    }

    private createFieldTypeControl(field: FieldSchema): HTMLElement {
        const wrapper = element('div', 'config-type-control');
        const locked = isRequiredField(field.key);
        wrapper.append(
            this.createFieldTypeSelect(field, locked),
            this.createArrayToggle(isArrayField(field.type), (checked) => {
                field.type = fieldTypeWithArray(baseFieldType(field.type), checked);
                if (!isStructuredField(field)) {
                    field.structure = undefined;
                }
                if (baseFieldType(field.type) !== 'number') {
                    field.numberConstraint = undefined;
                }
                this.render();
            }, locked)
        );
        return wrapper;
    }

    private createFieldTypeSelect(field: FieldSchema, disabled = false): HTMLSelectElement {
        const select = element('select', 'config-cell') as HTMLSelectElement;
        FIELD_BASE_TYPES.forEach((type) => select.append(new Option(type, type)));
        select.value = baseFieldType(field.type);
        select.disabled = disabled;
        select.addEventListener('change', () => {
            field.type = fieldTypeWithArray(select.value as FieldBaseType, isArrayField(field.type));
            if (!isStructuredField(field)) {
                field.structure = undefined;
            }
            if (baseFieldType(field.type) !== 'number') {
                field.numberConstraint = undefined;
            }
            this.render();
        });
        return select;
    }

    private createFieldDescriptionInput(field: FieldSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.value = field.description;
        input.placeholder = '含义描述';
        input.disabled = isRequiredField(field.key);
        input.addEventListener('input', () => {
            field.description = input.value;
        });
        input.addEventListener('change', () => this.scheduleRender());
        return input;
    }

    private createStructureFieldKeyInput(structure: StructureState, field: StructureFieldSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.value = field.key;
        input.placeholder = 'field_key';
        input.addEventListener('change', () => {
            this.renameStructureField(structure, field, input.value.trim());
            this.scheduleRender();
        });
        return input;
    }

    private createStructureFieldTypeControl(field: StructureFieldSchema): HTMLElement {
        const wrapper = element('div', 'config-type-control');
        wrapper.append(
            this.createStructureFieldTypeSelect(field),
            this.createArrayToggle(isArrayField(field.type), (checked) => {
                field.type = structureFieldTypeWithArray(baseFieldType(field.type) as BasicType, checked);
                if (baseFieldType(field.type) !== 'number') {
                    field.numberConstraint = undefined;
                }
                this.render();
            })
        );
        return wrapper;
    }

    private createStructureFieldTypeSelect(field: StructureFieldSchema): HTMLSelectElement {
        const select = element('select', 'config-cell') as HTMLSelectElement;
        BASIC_TYPES.forEach((type) => select.append(new Option(type, type)));
        select.value = baseFieldType(field.type);
        select.addEventListener('change', () => {
            field.type = structureFieldTypeWithArray(select.value as BasicType, isArrayField(field.type));
            if (baseFieldType(field.type) !== 'number') {
                field.numberConstraint = undefined;
            }
            this.render();
        });
        return select;
    }

    private createStructureFieldDescriptionInput(field: StructureFieldSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.value = field.description;
        input.placeholder = '含义描述';
        input.addEventListener('input', () => {
            field.description = input.value;
        });
        input.addEventListener('change', () => this.scheduleRender());
        return input;
    }

    private createEnumValueKeyInput(enumSchema: EnumState, enumValue: EnumValueSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.value = enumValue.key;
        input.placeholder = 'EnumValue';
        input.addEventListener('change', () => {
            this.renameEnumValueKey(enumSchema, enumValue, input.value.trim());
            this.scheduleRender();
        });
        return input;
    }

    private createEnumValueNumberInput(enumSchema: EnumState, enumValue: EnumValueSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.type = 'number';
        input.step = '1';
        input.value = String(enumValue.value);
        input.addEventListener('input', () => {
            const value = Number(input.value);
            enumValue.value = Number.isFinite(value) ? value : 0;
        });
        input.addEventListener('change', () => {
            this.sortEnumStateValues(enumSchema, enumValue);
            this.scheduleRender();
        });
        return input;
    }

    private createEnumValueDescriptionInput(enumValue: EnumValueSchema): HTMLInputElement {
        const input = element('input', 'config-cell') as HTMLInputElement;
        input.value = enumValue.description;
        input.placeholder = '含义描述';
        input.addEventListener('input', () => {
            enumValue.description = input.value;
        });
        input.addEventListener('change', () => this.scheduleRender());
        return input;
    }

    private createArrayToggle(checked: boolean, onChange: (checked: boolean) => void, disabled = false): HTMLElement {
        const label = element('label', 'field-row__array');
        const checkbox = element('input') as HTMLInputElement;
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        checkbox.disabled = disabled;
        checkbox.addEventListener('change', () => onChange(checkbox.checked));
        label.append(checkbox, element('span', '', '数组'));
        return label;
    }

    private createFieldStructureSelect(field: FieldSchema): HTMLSelectElement {
        const select = element('select', 'field-row__structure') as HTMLSelectElement;
        select.append(new Option(isStructuredField(field) ? '无结构' : '仅 JSON 可选', ''));
        this.structures.forEach((structure) => select.append(new Option(structure.key, structure.key)));
        select.value = field.structure ?? '';
        select.disabled = !isStructuredField(field);
        select.addEventListener('change', () => {
            field.structure = select.value || undefined;
            this.render();
        });
        return select;
    }

    private createNumberConstraintEditor(field: FieldSchema | StructureFieldSchema): HTMLElement {
        const wrapper = element('div', 'config-number-constraint');
        const constraint = normalizedNumberConstraint(field.type, field.numberConstraint) ?? { kind: 'number' as NumberConstraintKind };
        const kindSelect = element('select', 'config-cell') as HTMLSelectElement;
        kindSelect.append(
            new Option('数字', 'number'),
            new Option('引用', 'reference'),
            new Option('枚举', 'enum')
        );
        kindSelect.value = constraint.kind;
        kindSelect.addEventListener('change', () => {
            field.numberConstraint = compactNumberConstraint(field.type, { kind: kindSelect.value as NumberConstraintKind });
            this.render();
        });

        wrapper.append(kindSelect);
        if (constraint.kind === 'number') {
            wrapper.append(this.createNumberRangeEditor(field, constraint));
        } else if (constraint.kind === 'reference') {
            wrapper.append(this.createReferenceTableSelect(field, constraint.table ?? ''));
        } else {
            wrapper.append(this.createEnumSelect(field, constraint.enum ?? ''));
        }
        return wrapper;
    }

    private createNumberRangeEditor(field: FieldSchema | StructureFieldSchema, constraint: NumberConstraintSchema): HTMLElement {
        const wrapper = element('div', 'config-number-range');
        const minInput = element('input', 'config-cell') as HTMLInputElement;
        minInput.type = 'number';
        minInput.step = 'any';
        minInput.placeholder = '最小值';
        minInput.value = constraint.min === undefined ? '' : String(constraint.min);
        minInput.addEventListener('input', () => {
            field.numberConstraint = this.nextNumberRangeConstraint(field, 'min', minInput.value);
        });
        minInput.addEventListener('change', () => this.scheduleRender());

        const maxInput = element('input', 'config-cell') as HTMLInputElement;
        maxInput.type = 'number';
        maxInput.step = 'any';
        maxInput.placeholder = '最大值';
        maxInput.value = constraint.max === undefined ? '' : String(constraint.max);
        maxInput.addEventListener('input', () => {
            field.numberConstraint = this.nextNumberRangeConstraint(field, 'max', maxInput.value);
        });
        maxInput.addEventListener('change', () => this.scheduleRender());

        wrapper.append(minInput, maxInput);
        return wrapper;
    }

    private nextNumberRangeConstraint(
        field: FieldSchema | StructureFieldSchema,
        key: 'min' | 'max',
        value: string
    ): NumberConstraintSchema | undefined {
        const current = normalizedNumberConstraint(field.type, field.numberConstraint) ?? { kind: 'number' as const };
        const next: NumberConstraintSchema = {
            kind: 'number',
            min: current.kind === 'number' ? current.min : undefined,
            max: current.kind === 'number' ? current.max : undefined
        };
        const numericValue = optionalNumber(value);
        if (numericValue === undefined) {
            delete next[key];
        } else {
            next[key] = numericValue;
        }
        return compactNumberConstraint(field.type, next);
    }

    private createReferenceTableSelect(field: FieldSchema | StructureFieldSchema, tableKey: string): HTMLSelectElement {
        const select = element('select', 'config-cell') as HTMLSelectElement;
        select.append(new Option('选择引用表', ''));
        this.tables.forEach((table) => select.append(new Option(table.moduleKey, table.moduleKey)));
        select.value = tableKey;
        select.addEventListener('change', () => {
            field.numberConstraint = compactNumberConstraint(field.type, {
                kind: 'reference',
                table: select.value
            });
            this.scheduleRender();
        });
        return select;
    }

    private createEnumSelect(field: FieldSchema | StructureFieldSchema, enumKey: string): HTMLSelectElement {
        const select = element('select', 'config-cell') as HTMLSelectElement;
        select.append(new Option(this.enums.length === 0 ? '暂无枚举类型' : '选择枚举类型', ''));
        this.enums.forEach((enumSchema) => select.append(new Option(enumSchemaOptionLabel(enumSchema), enumSchema.key)));
        if (enumKey && !this.enums.some((enumSchema) => enumSchema.key === enumKey)) {
            select.append(new Option(`未知枚举：${enumKey}`, enumKey));
        }
        select.value = enumKey;
        select.disabled = this.enums.length === 0 && !enumKey;
        select.addEventListener('change', () => {
            field.numberConstraint = compactNumberConstraint(field.type, {
                kind: 'enum',
                enum: select.value
            });
            this.scheduleRender();
        });
        return select;
    }

    private createDataEditor(table: CsvTableState): HTMLElement {
        this.ensureTableRowSelection(table);
        const panel = element('section', 'config-panel config-panel--data');
        const header = element('div', 'config-panel__header');
        header.append(element('h3', 'config-panel__title', `数据行 · ${table.rows.length}`));
        panel.append(header);

        const editor = element('div', 'config-data-editor');
        editor.append(
            this.createRowList(table),
            this.createDataWorkspace(table),
            this.createOverviewColumn('全部数据', this.createReadonlyTable(table))
        );
        panel.append(editor);
        return panel;
    }

    private createRowList(table: CsvTableState): HTMLElement {
        const sidebar = element('aside', 'config-row-nav');
        const list = element('div', 'config-row-nav__list');
        if (table.rows.length === 0) {
            list.append(element('div', 'config-row-nav__empty', '暂无数据行。'));
        }

        table.rows.forEach((row, rowIndex) => {
            const item = element('div', 'config-row-nav__item');
            const dirty = this.isTableRowDirty(table, rowIndex);
            const rowButton = element('button', navSelectClass(table.selectedRowIndex === rowIndex, dirty)) as HTMLButtonElement;
            rowButton.type = 'button';
            rowButton.textContent = rowLabel(row, rowIndex);
            rowButton.title = dirty ? '未保存修改' : '';
            rowButton.addEventListener('click', () => {
                table.selectedRowIndex = rowIndex;
                this.render();
            });
            item.append(rowButton, this.createRowNavActions([
                this.createMoveButton('上移', rowIndex === 0, () => this.moveRow(table, rowIndex, -1)),
                this.createMoveButton('下移', rowIndex === table.rows.length - 1, () => this.moveRow(table, rowIndex, 1)),
                button('删除', 'button button--ghost config-row-nav__delete', () => void this.removeRow(table, rowIndex))
            ]));
            list.append(item);
        });

        sidebar.append(
            this.createRowNavToolbar([
                button('新增', 'button button--secondary config-row-nav__add', () => this.addRow(table)),
                button('保存', 'button button--primary config-row-nav__save', () => void this.saveTableRows(table))
            ]),
            list
        );
        return sidebar;
    }

    private createDataWorkspace(table: CsvTableState): HTMLElement {
        const selectedRow = table.selectedRowIndex === undefined ? undefined : table.rows[table.selectedRowIndex];
        const workspace = element('div', 'config-row-workspace');
        if (!selectedRow) {
            workspace.append(element('div', 'empty-state', '选择左侧数据行进行编辑。'));
            return workspace;
        }

        workspace.append(this.createRowEditor(table, selectedRow, table.selectedRowIndex ?? 0));
        return workspace;
    }

    private createReadonlyTable(table: CsvTableState): HTMLElement {
        const scroll = element('div', 'config-data-scroll');
        const dataTable = element('table', 'config-data-table');
        const thead = element('thead');
        const headRow = element('tr');
        headRow.append(element('th', 'config-data-table__index', '#'));
        table.savedFields.forEach((field) => {
            const cell = element('th');
            const label = element('span', 'config-data-table__field', field.key);
            label.title = field.description;
            cell.append(label, element('span', 'config-data-table__type', field.type));
            headRow.append(cell);
        });
        thead.append(headRow);

        const tbody = element('tbody');
        if (table.savedRows.length === 0) {
            const emptyRow = element('tr');
            const emptyCell = element('td', 'config-data-table__empty', '暂无数据行。') as HTMLTableCellElement;
            emptyCell.colSpan = table.savedFields.length + 1;
            emptyRow.append(emptyCell);
            tbody.append(emptyRow);
        }

        table.savedRows.forEach((row, rowIndex) => {
            const tr = element('tr');
            tr.append(element('td', 'config-data-table__index', String(rowIndex + 1)));
            table.savedFields.forEach((field) => {
                const td = element('td');
                const readonlyValue = this.readonlyCellValue(row[field.key] ?? '', field);
                const value = element('span', 'config-data-table__value', readonlyValue);
                value.title = readonlyValue;
                td.append(value);
                tr.append(td);
            });
            tbody.append(tr);
        });

        dataTable.append(thead, tbody);
        scroll.append(dataTable);
        return scroll;
    }

    private readonlyCellValue(value: string, field: FieldSchema): string {
        const constraint = normalizedNumberConstraint(field.type, field.numberConstraint);
        if (isArrayField(field.type) && baseFieldType(field.type) === 'number' && constraint) {
            const parsed = parseArrayValue(value);
            return parsed.length > 0
                ? `[${parsed.map((item) => this.readonlyConstrainedNumberValue(valueToBasicString(item, 'number'), constraint)).join(', ')}]`
                : value;
        }

        if (field.type === 'number' && constraint) {
            return this.readonlyConstrainedNumberValue(value, constraint);
        }

        return value;
    }

    private readonlyConstrainedNumberValue(value: string, constraint: NumberConstraintSchema): string {
        if (!value.trim()) {
            return value;
        }
        if (constraint.kind === 'enum') {
            return this.readonlyEnumValue(value, constraint.enum ?? '');
        }
        if (constraint.kind === 'reference') {
            return this.readonlyReferenceValue(value, constraint.table ?? '');
        }
        return value;
    }

    private readonlyEnumValue(value: string, enumKey: string): string {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return value;
        }
        const enumValue = this.enumForKey(enumKey)?.savedValues.find((item) => item.value === numericValue);
        return enumValue ? `${enumValue.key}(${enumValue.value})` : value;
    }

    private readonlyReferenceValue(value: string, tableKey: string): string {
        const trimmedValue = value.trim();
        const table = this.tables.find((item) => item.moduleKey === tableKey);
        const exactRow = table?.savedRows.find((row) => (row.id ?? '').trim() === trimmedValue);
        const numericRow = exactRow ?? table?.savedRows.find((row) => {
            const rowId = Number((row.id ?? '').trim());
            const valueId = Number(trimmedValue);
            return Number.isFinite(rowId) && Number.isFinite(valueId) && rowId === valueId;
        });
        if (!numericRow) {
            return value;
        }

        const id = (numericRow.id ?? '').trim();
        const name = (numericRow.name ?? '').trim();
        return name ? `${id}.${name}` : id;
    }

    private createRowEditor(table: CsvTableState, row: CsvRow, rowIndex: number): HTMLElement {
        const editor = element('section', 'config-row-editor');
        const header = element('div', 'config-row-editor__header');
        header.append(element('h3', 'config-row-editor__title', rowLabel(row, rowIndex)));

        const fields = element('div', 'config-row-fields');
        table.fields.forEach((field) => {
            const fieldWrapper = element('div', 'config-row-field');
            const label = element('span', 'config-row-field__label', field.key);
            const typeLabel = field.structure ? `${field.type}<${field.structure}>` : field.type;
            const meta = element('span', 'config-row-field__meta', field.description ? `${typeLabel} · ${field.description}` : typeLabel);
            fieldWrapper.append(label, meta, this.createCellEditor(row, field));
            fields.append(fieldWrapper);
        });

        editor.append(header, fields);
        return editor;
    }

    private createCellEditor(row: CsvRow, field: FieldSchema): HTMLElement {
        const value = row[field.key] ?? '';
        const structure = this.structureForField(field);
        if (isArrayField(field.type)) {
            return this.createArrayEditor(
                parseArrayValue(value),
                field,
                (items) => {
                    row[field.key] = JSON.stringify(items);
                },
                structure
            );
        }

        if (field.type === 'json' && structure) {
            return this.createStructuredObjectEditor(
                parseObjectValue(value, structure),
                structure,
                (objectValue) => {
                    row[field.key] = JSON.stringify(objectValue);
                }
            );
        }

        if (field.type === 'json') {
            const textarea = element('textarea', 'config-cell config-cell--json') as HTMLTextAreaElement;
            textarea.value = value;
            textarea.rows = 3;
            textarea.spellcheck = false;
            textarea.addEventListener('input', () => {
                row[field.key] = textarea.value;
            });
            textarea.addEventListener('change', () => this.scheduleRender());
            return textarea;
        }

        if (field.type === 'number') {
            return this.createNumberCellEditor(value, field, (nextValue) => {
                row[field.key] = nextValue;
            });
        }

        return this.createBasicEditor(value, field.type as BasicType, (nextValue) => {
            row[field.key] = nextValue;
        });
    }

    private createNumberCellEditor(
        value: string,
        field: FieldSchema | StructureFieldSchema,
        onChange: (value: string) => void
    ): HTMLElement {
        const constraint = normalizedNumberConstraint(field.type, field.numberConstraint);
        if (constraint?.kind === 'reference') {
            return this.createReferenceValueSelect(value, constraint.table ?? '', onChange);
        }
        if (constraint?.kind === 'enum') {
            return this.createEnumValueSelect(value, constraint.enum ?? '', onChange);
        }
        return this.createBasicEditor(value, 'number', onChange);
    }

    private createReferenceValueSelect(value: string, tableKey: string, onChange: (value: string) => void): HTMLSelectElement {
        const select = element('select', 'config-cell') as HTMLSelectElement;
        const table = this.tables.find((item) => item.moduleKey === tableKey);
        const optionValues = new Set<string>();
        select.append(new Option(table ? '未选择' : '未指定引用表', ''));

        table?.savedRows.forEach((row) => {
            const id = (row.id ?? '').trim();
            if (!id || optionValues.has(id)) {
                return;
            }
            optionValues.add(id);
            const option = new Option(referenceRowOptionLabel(row, id), id);
            option.title = option.text;
            select.append(option);
        });

        if (value && !optionValues.has(value)) {
            select.append(new Option(`当前值：${value}`, value));
        }
        select.value = value;
        select.addEventListener('change', () => {
            onChange(select.value);
            this.scheduleRender();
        });
        return select;
    }

    private createEnumValueSelect(value: string, enumKey: string, onChange: (value: string) => void): HTMLSelectElement {
        const select = element('select', 'config-cell') as HTMLSelectElement;
        const enumSchema = this.enumForKey(enumKey);
        const optionValues = new Set<string>();
        select.append(new Option(enumSchema ? '未选择' : '未指定枚举类型', ''));

        enumSchema?.savedValues.forEach((enumValue) => {
            const optionValue = String(enumValue.value);
            if (optionValues.has(optionValue)) {
                return;
            }
            optionValues.add(optionValue);
            const option = new Option(enumValueOptionLabel(enumValue, optionValue), optionValue);
            option.title = option.text;
            select.append(option);
        });

        if (value && !optionValues.has(value)) {
            select.append(new Option(`当前值：${value}`, value));
        }
        select.value = value;
        select.addEventListener('change', () => {
            onChange(select.value);
            this.scheduleRender();
        });
        return select;
    }

    private createBasicEditor(value: string, type: BasicType, onChange: (value: string) => void): HTMLElement {
        if (type === 'boolean') {
            const label = element('label', 'config-cell-check');
            const checkbox = element('input') as HTMLInputElement;
            checkbox.type = 'checkbox';
            checkbox.checked = value === 'true';
            checkbox.addEventListener('change', () => {
                onChange(checkbox.checked ? 'true' : 'false');
                this.render();
            });
            label.append(checkbox);
            return label;
        }

        const input = element('input', 'config-cell') as HTMLInputElement;
        input.type = type === 'number' ? 'number' : 'text';
        input.step = type === 'number' ? 'any' : '';
        input.value = value;
        input.addEventListener('input', () => onChange(input.value));
        input.addEventListener('change', () => this.scheduleRender());
        return input;
    }

    private createArrayEditor(items: unknown[], field: FieldSchema, onChange: (items: unknown[]) => void, structure?: StructureState): HTMLElement {
        const wrapper = element('div', 'config-array-editor');
        const list = element('div', 'config-array-editor__list');
        const itemType = arrayItemType(field.type);
        const currentItems = items.slice();

        if (items.length === 0) {
            list.append(element('div', 'config-array-editor__empty', '暂无项目。'));
        }

        items.forEach((item, index) => {
            const row = element('div', structure ? 'config-array-item config-array-item--object' : 'config-array-item');
            const indexNode = element('span', 'config-array-item__index', String(index + 1));
            const editor = this.createArrayItemEditor(item, field, itemType, structure, (nextItem) => {
                currentItems[index] = nextItem;
                onChange(currentItems);
            });
            const removeButton = button('删除', 'button button--ghost config-array-item__remove', () => {
                onChange(currentItems.filter((_, itemIndex) => itemIndex !== index));
                this.render();
            });
            row.append(indexNode, editor, removeButton);
            list.append(row);
        });

        const addButton = button('新增项', 'button button--secondary config-array-editor__add', () => {
            onChange(currentItems.concat(defaultArrayItem(field.type, structure)));
            this.render();
        });
        wrapper.append(list, addButton);
        return wrapper;
    }

    private createArrayItemEditor(
        item: unknown,
        field: FieldSchema,
        itemType: BasicType | 'json',
        structure: StructureState | undefined,
        onChange: (item: unknown) => void
    ): HTMLElement {
        if (itemType === 'json' && structure) {
            return this.createStructuredObjectEditor(asObject(item, structure), structure, onChange);
        }

        if (itemType === 'json') {
            const textarea = element('textarea', 'config-cell config-cell--json') as HTMLTextAreaElement;
            textarea.value = item === undefined ? '' : JSON.stringify(item);
            textarea.rows = 2;
            textarea.spellcheck = false;
            textarea.addEventListener('change', () => {
                try {
                    onChange(JSON.parse(textarea.value));
                } catch {
                    onChange(textarea.value);
                }
                this.scheduleRender();
            });
            return textarea;
        }

        if (itemType === 'number') {
            return this.createNumberCellEditor(valueToBasicString(item, itemType), field, (nextValue) => {
                onChange(basicStringToValue(nextValue, itemType));
            });
        }

        return this.createBasicEditor(valueToBasicString(item, itemType), itemType, (nextValue) => {
            onChange(basicStringToValue(nextValue, itemType));
        });
    }

    private createStructuredObjectEditor(value: Record<string, unknown>, structure: StructureState, onChange: (value: Record<string, unknown>) => void): HTMLElement {
        const wrapper = element('div', 'config-structure-editor');
        const currentValue = { ...value };
        if (structure.fields.length === 0) {
            wrapper.append(element('div', 'empty-state', '该结构暂无字段。'));
            return wrapper;
        }

        structure.fields.forEach((field) => {
            const row = element('div', 'config-structure-field');
            const label = element('span', 'config-structure-field__label', field.key);
            const meta = element('span', 'config-structure-field__meta', field.description ? `${field.type} · ${field.description}` : field.type);
            let editor: HTMLElement;
            if (isArrayField(field.type)) {
                editor = this.createArrayEditor(
                    arrayFromUnknown(value[field.key]),
                    {
                        key: field.key,
                        type: field.type as FieldType,
                        description: field.description,
                        numberConstraint: field.numberConstraint
                    },
                    (items) => {
                        currentValue[field.key] = items;
                        onChange(currentValue);
                    }
                );
            } else if (field.type === 'number') {
                editor = this.createNumberCellEditor(valueToBasicString(value[field.key], field.type), field, (nextValue) => {
                    currentValue[field.key] = basicStringToValue(nextValue, 'number');
                    onChange(currentValue);
                });
            } else {
                const basicType = field.type as BasicType;
                editor = this.createBasicEditor(valueToBasicString(value[field.key], basicType), basicType, (nextValue) => {
                    currentValue[field.key] = basicStringToValue(nextValue, basicType);
                    onChange(currentValue);
                });
            }
            row.append(label, meta, editor);
            wrapper.append(row);
        });
        return wrapper;
    }

    private createJsonEditor(constant: ConstantState): HTMLElement {
        const panel = element('section', 'config-panel config-panel--json');
        const header = element('div', 'config-panel__header');
        const actions = element('div', 'config-panel__actions');
        actions.append(
            button('格式化 JSON', 'button button--secondary button--header', () => this.formatConstant(constant)),
            button('保存', 'button button--primary button--header', () => void this.save('JSON 内容已保存。', { kind: 'constant', constant }))
        );
        header.append(element('h3', 'config-panel__title', 'JSON 内容'), actions);
        const validation = element('div', 'config-json-status', this.jsonStatus(constant.text));
        const textarea = element('textarea', 'config-json-editor') as HTMLTextAreaElement;
        textarea.value = constant.text;
        textarea.spellcheck = false;
        textarea.addEventListener('input', () => {
            constant.text = textarea.value;
            validation.textContent = this.jsonStatus(constant.text);
        });
        panel.append(header, validation, textarea);
        return panel;
    }

    private addTable(): void {
        const moduleKey = this.uniqueModuleKey('battle.new_table');
        const table: CsvTableState = {
            id: createId('table', moduleKey),
            moduleKey,
            path: defaultPathForModule(moduleKey, '.csv'),
            originalPath: '',
            fields: [
                { key: 'id', type: 'number', description: requiredFieldDescription('id') },
                { key: 'name', type: 'string', description: requiredFieldDescription('name') }
            ],
            rows: [],
            activeTab: 'schema',
            savedModuleKey: '',
            savedFields: [],
            savedRows: [],
            selectedFieldIndex: undefined,
            selectedRowIndex: undefined
        };
        this.tables.push(table);
        this.activeKind = 'table';
        this.selected = { kind: 'table', id: table.id };
        this.status = '已创建 CSV 表草稿，保存后写入文件。';
        this.render();
    }

    private addConstant(): void {
        const moduleKey = this.uniqueModuleKey('battle.new_constants');
        const constant: ConstantState = {
            id: createId('constant', moduleKey),
            moduleKey,
            path: defaultPathForModule(moduleKey, '.json'),
            originalPath: '',
            description: '',
            text: '{\n}\n',
            savedModuleKey: '',
            savedDescription: '',
            savedText: ''
        };
        this.constants.push(constant);
        this.activeKind = 'constant';
        this.selected = { kind: 'constant', id: constant.id };
        this.status = '已创建 JSON 草稿，保存后写入文件。';
        this.render();
    }

    private addStructure(): void {
        const key = this.uniqueStructureKey('NewStructure');
        const structure: StructureState = {
            id: createId('structure', key),
            key,
            description: '',
            fields: [
                { key: 'value', type: 'number', description: '' }
            ],
            savedFields: [],
            selectedFieldIndex: undefined
        };
        this.structures.push(structure);
        this.activeKind = 'structure';
        this.selected = { kind: 'structure', id: structure.id };
        this.status = '已创建自定义结构草稿，保存后写入 schema。';
        this.render();
    }

    private addEnum(): void {
        const key = this.uniqueEnumKey('NewEnum');
        const enumSchema: EnumState = {
            id: createId('enum', key),
            key,
            description: '',
            values: [
                { key: 'Value', value: 1, description: '' }
            ],
            savedValues: [],
            selectedValueIndex: undefined
        };
        this.enums.push(enumSchema);
        this.activeKind = 'enum';
        this.selected = { kind: 'enum', id: enumSchema.id };
        this.status = '已创建自定义枚举草稿，保存后写入 schema。';
        this.render();
    }

    private async deleteTable(table: CsvTableState): Promise<void> {
        if (!window.confirm(`删除 CSV 表 ${table.moduleKey}？确认后会立即保存并删除对应文件。`)) {
            return;
        }
        if (table.originalPath) {
            this.deletedPaths.add(table.originalPath);
        }
        this.tables = this.tables.filter((item) => item.id !== table.id);
        this.selected = undefined;
        this.ensureSelection();
        await this.save('CSV 表已删除。', { kind: 'none' });
    }

    private async deleteConstant(constant: ConstantState): Promise<void> {
        if (!window.confirm(`删除 JSON ${constant.moduleKey}？确认后会立即保存并删除对应文件。`)) {
            return;
        }
        if (constant.originalPath) {
            this.deletedPaths.add(constant.originalPath);
        }
        this.constants = this.constants.filter((item) => item.id !== constant.id);
        this.selected = undefined;
        this.ensureSelection();
        await this.save('JSON 已删除。', { kind: 'none' });
    }

    private async deleteStructure(structure: StructureState): Promise<void> {
        if (this.tables.some((table) => table.fields.some((field) => field.structure === structure.key))) {
            this.status = `结构 ${structure.key} 正被 CSV 字段引用，不能删除。`;
            this.render();
            return;
        }
        if (!window.confirm(`删除结构 ${structure.key}？确认后会立即保存。`)) {
            return;
        }
        this.structures = this.structures.filter((item) => item.id !== structure.id);
        this.selected = undefined;
        this.ensureSelection();
        await this.save('结构已删除。', { kind: 'none' });
    }

    private async deleteEnum(enumSchema: EnumState): Promise<void> {
        if (this.isEnumReferenced(enumSchema.key)) {
            this.status = `枚举 ${enumSchema.key} 正被数字字段引用，不能删除。`;
            this.render();
            return;
        }
        if (!window.confirm(`删除枚举 ${enumSchema.key}？确认后会立即保存。`)) {
            return;
        }
        this.enums = this.enums.filter((item) => item.id !== enumSchema.id);
        this.selected = undefined;
        this.ensureSelection();
        await this.save('枚举已删除。', { kind: 'none' });
    }

    private addField(table: CsvTableState): void {
        const key = uniqueFieldKey(table.fields, 'field');
        table.fields.push({ key, type: 'string', description: '' });
        table.rows.forEach((row) => {
            row[key] = '';
        });
        table.activeTab = 'schema';
        table.selectedFieldIndex = table.fields.length - 1;
        this.status = '已新增字段，编辑后点击保存写入文件。';
        this.render();
    }

    private canMoveField(table: CsvTableState, fieldIndex: number, direction: -1 | 1): boolean {
        const field = table.fields[fieldIndex];
        const targetField = table.fields[fieldIndex + direction];
        return Boolean(field)
            && Boolean(targetField)
            && !isRequiredField(field.key)
            && !isRequiredField(targetField.key);
    }

    private moveField(table: CsvTableState, fieldIndex: number, direction: -1 | 1): void {
        if (!this.canMoveField(table, fieldIndex, direction)) {
            return;
        }
        const targetIndex = fieldIndex + direction;
        swapItems(table.fields, fieldIndex, targetIndex);
        table.selectedFieldIndex = remapMovedSelection(table.selectedFieldIndex, fieldIndex, targetIndex);
        this.status = '字段顺序已调整，点击保存写入文件。';
        this.render();
    }

    private async removeField(table: CsvTableState, field: FieldSchema): Promise<void> {
        if (isRequiredField(field.key)) {
            this.status = `字段 ${field.key} 是所有 CSV 表的必需字段。`;
            this.render();
            return;
        }
        if (table.fields.length <= 1) {
            this.status = 'CSV 表至少需要保留一个字段。';
            this.render();
            return;
        }
        if (!window.confirm(`删除字段 ${field.key}？确认后会立即保存并从所有数据行移除该列。`)) {
            return;
        }
        const fieldIndex = table.fields.indexOf(field);
        table.fields = table.fields.filter((item) => item !== field);
        table.rows.forEach((row) => {
            delete row[field.key];
        });
        if (table.selectedFieldIndex === fieldIndex) {
            table.selectedFieldIndex = undefined;
        } else if (table.selectedFieldIndex !== undefined && table.selectedFieldIndex > fieldIndex) {
            table.selectedFieldIndex -= 1;
        }
        await this.save('字段已删除。', { kind: 'table', table });
    }

    private renameField(table: CsvTableState, field: FieldSchema, nextKey: string): void {
        const previousKey = field.key;
        if (isRequiredField(previousKey)) {
            this.status = `字段 ${previousKey} 是所有 CSV 表的必需字段，不能重命名。`;
            return;
        }
        if (!/^[A-Za-z0-9_]+$/.test(nextKey)) {
            this.status = `字段 key 无效：${nextKey}`;
            return;
        }
        if (table.fields.some((item) => item !== field && item.key === nextKey)) {
            this.status = `字段 key 重复：${nextKey}`;
            return;
        }
        if (previousKey === nextKey) {
            return;
        }

        field.key = nextKey;
        table.rows.forEach((row) => {
            row[nextKey] = row[previousKey] ?? row[nextKey] ?? '';
            if (previousKey !== nextKey) {
                delete row[previousKey];
            }
        });
    }

    private addRow(table: CsvTableState): void {
        table.rows.push(Object.fromEntries(table.fields.map((field) => [field.key, defaultCellValue(field.type)])));
        table.activeTab = 'data';
        table.selectedRowIndex = table.rows.length - 1;
        this.status = '已新增数据行，编辑后点击保存写入文件。';
        this.render();
    }

    private moveRow(table: CsvTableState, rowIndex: number, direction: -1 | 1): void {
        const targetIndex = rowIndex + direction;
        if (!table.rows[rowIndex] || !table.rows[targetIndex]) {
            return;
        }
        swapItems(table.rows, rowIndex, targetIndex);
        table.selectedRowIndex = remapMovedSelection(table.selectedRowIndex, rowIndex, targetIndex);
        this.status = '数据行顺序已调整，点击保存写入文件。';
        this.render();
    }

    private async removeRow(table: CsvTableState, rowIndex: number): Promise<void> {
        const row = table.rows[rowIndex];
        if (!row || !window.confirm(`删除数据行 ${rowLabel(row, rowIndex)}？确认后会立即保存。`)) {
            return;
        }
        table.rows = table.rows.filter((_, index) => index !== rowIndex);
        if (table.selectedRowIndex === rowIndex) {
            table.selectedRowIndex = undefined;
        } else if (table.selectedRowIndex !== undefined && table.selectedRowIndex > rowIndex) {
            table.selectedRowIndex -= 1;
        }
        await this.saveTableRows(table, '数据行已删除。');
    }

    private addStructureField(structure: StructureState): void {
        structure.fields.push({
            key: uniqueStructureFieldKey(structure.fields, 'field'),
            type: 'string',
            description: ''
        });
        structure.selectedFieldIndex = structure.fields.length - 1;
        this.status = '已新增结构字段，编辑后点击保存写入文件。';
        this.render();
    }

    private moveStructureField(structure: StructureState, fieldIndex: number, direction: -1 | 1): void {
        const targetIndex = fieldIndex + direction;
        if (!structure.fields[fieldIndex] || !structure.fields[targetIndex]) {
            return;
        }
        swapItems(structure.fields, fieldIndex, targetIndex);
        structure.selectedFieldIndex = remapMovedSelection(structure.selectedFieldIndex, fieldIndex, targetIndex);
        this.status = '结构字段顺序已调整，点击保存写入文件。';
        this.render();
    }

    private addEnumValue(enumSchema: EnumState): void {
        const enumValue: EnumValueSchema = {
            key: uniqueEnumValueKey(enumSchema.values, 'Value'),
            value: nextEnumValue(enumSchema.values),
            description: ''
        };
        enumSchema.values.push(enumValue);
        this.sortEnumStateValues(enumSchema, enumValue);
        this.status = '已新增枚举值，编辑后点击保存写入文件。';
        this.render();
    }

    private sortEnumStateValues(enumSchema: EnumState, selectedValue?: EnumValueSchema): void {
        const currentValue = selectedValue ?? enumSchema.values[enumSchema.selectedValueIndex ?? -1];
        enumSchema.values = sortEnumValues(enumSchema.values);
        if (currentValue) {
            const nextIndex = enumSchema.values.indexOf(currentValue);
            enumSchema.selectedValueIndex = nextIndex >= 0 ? nextIndex : undefined;
        }
    }

    private async removeStructureField(structure: StructureState, field: StructureFieldSchema): Promise<void> {
        if (!window.confirm(`删除结构字段 ${field.key}？确认后会立即保存。`)) {
            return;
        }
        const fieldIndex = structure.fields.indexOf(field);
        structure.fields = structure.fields.filter((item) => item !== field);
        if (structure.selectedFieldIndex === fieldIndex) {
            structure.selectedFieldIndex = undefined;
        } else if (structure.selectedFieldIndex !== undefined && structure.selectedFieldIndex > fieldIndex) {
            structure.selectedFieldIndex -= 1;
        }
        await this.save('结构字段已删除。', { kind: 'structure', structure });
    }

    private async removeEnumValue(enumSchema: EnumState, enumValue: EnumValueSchema): Promise<void> {
        if (!window.confirm(`删除枚举值 ${enumValue.key}？确认后会立即保存。`)) {
            return;
        }
        const valueIndex = enumSchema.values.indexOf(enumValue);
        enumSchema.values = enumSchema.values.filter((item) => item !== enumValue);
        if (enumSchema.selectedValueIndex === valueIndex) {
            enumSchema.selectedValueIndex = undefined;
        } else if (enumSchema.selectedValueIndex !== undefined && enumSchema.selectedValueIndex > valueIndex) {
            enumSchema.selectedValueIndex -= 1;
        }
        await this.save('枚举值已删除。', { kind: 'enum', enumSchema });
    }

    private renameStructureField(structure: StructureState, field: StructureFieldSchema, nextKey: string): void {
        if (!/^[A-Za-z0-9_]+$/.test(nextKey)) {
            this.status = `结构字段 key 无效：${nextKey}`;
            return;
        }
        if (structure.fields.some((item) => item !== field && item.key === nextKey)) {
            this.status = `结构字段 key 重复：${nextKey}`;
            return;
        }
        field.key = nextKey;
    }

    private renameEnumValueKey(enumSchema: EnumState, enumValue: EnumValueSchema, nextKey: string): void {
        if (!/^[A-Za-z0-9_]+$/.test(nextKey)) {
            this.status = `枚举值 key 无效：${nextKey}`;
            return;
        }
        if (enumSchema.values.some((item) => item !== enumValue && item.key === nextKey)) {
            this.status = `枚举值 key 重复：${nextKey}`;
            return;
        }
        enumValue.key = nextKey;
    }

    private renameStructureKey(structure: StructureState, nextKey: string): void {
        const previousKey = structure.key;
        if (previousKey === nextKey) {
            return;
        }
        structure.key = nextKey;
        this.tables.forEach((table) => {
            table.fields.forEach((field) => {
                if (field.structure === previousKey) {
                    field.structure = nextKey;
                }
            });
        });
    }

    private renameEnumKey(enumSchema: EnumState, nextKey: string): void {
        const previousKey = enumSchema.key;
        if (previousKey === nextKey) {
            return;
        }
        enumSchema.key = nextKey;
        this.tables.forEach((table) => {
            table.fields.forEach((field) => {
                if (field.numberConstraint?.kind === 'enum' && field.numberConstraint.enum === previousKey) {
                    field.numberConstraint.enum = nextKey;
                }
            });
        });
        this.structures.forEach((structure) => {
            structure.fields.forEach((field) => {
                if (field.numberConstraint?.kind === 'enum' && field.numberConstraint.enum === previousKey) {
                    field.numberConstraint.enum = nextKey;
                }
            });
        });
    }

    private formatConstant(constant: ConstantState): void {
        try {
            constant.text = `${JSON.stringify(JSON.parse(constant.text), null, 4)}\n`;
            this.status = 'JSON 已格式化。';
        } catch (error) {
            this.status = `JSON 无法格式化：${errorMessage(error)}`;
        }
        this.render();
    }

    private jsonStatus(text: string): string {
        try {
            JSON.parse(text);
            return 'JSON 有效。';
        } catch (error) {
            return `JSON 错误：${errorMessage(error)}`;
        }
    }

    private async saveTableRows(table: CsvTableState, successStatus = '数据行已保存。'): Promise<void> {
        if (!this.writable) {
            this.status = '只读模式，无法写入配置文件。';
            this.render();
            return;
        }

        const errors = this.validateTableRowsSave(table);
        if (errors.length > 0) {
            this.status = errors[0];
            this.render();
            return;
        }

        const selectionSnapshot = this.captureSelectionSnapshot();
        this.loading = true;
        this.status = '正在保存数据行。';
        this.render();

        try {
            const payload = await this.postSaveRequest(this.createTableRowsSaveRequest(table));
            this.applySavedRowsFromPayload(table, payload);
            this.restoreSelectionSnapshot(selectionSnapshot);
            this.status = successStatus;
        } catch (error) {
            this.status = `保存失败：${errorMessage(error)}`;
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private validateTableRowsSave(table: CsvTableState): string[] {
        const errors: string[] = [];
        if (!table.savedModuleKey || table.savedFields.length === 0) {
            errors.push(`${table.moduleKey} 表定义尚未保存，请先保存表定义。`);
            return errors;
        }
        if (this.hasUnsavedTableDefinition(table)) {
            errors.push(`${table.moduleKey} 存在未保存的表定义修改，请先保存表定义。`);
            return errors;
        }

        const savedFields = table.savedFields.map(cloneFieldSchema);
        this.validateRows(
            {
                ...table,
                moduleKey: table.savedModuleKey,
                fields: savedFields,
                rows: table.rows.map((row) => withFieldDefaults(row, savedFields))
            },
            errors,
            (field) => this.savedStructureForField(field),
            (enumKey) => this.savedEnumForKey(enumKey)
        );
        return errors;
    }

    private hasUnsavedTableDefinition(table: CsvTableState): boolean {
        return table.moduleKey !== table.savedModuleKey
            || table.fields.length !== table.savedFields.length
            || table.fields.some((_, fieldIndex) => this.isTableFieldDirty(table, fieldIndex));
    }

    private createFullSaveRequest(): ConfigToolSaveRequest {
        return {
            manifest: this.manifest,
            schema: {
                ...this.schema,
                structures: structuresToRecord(this.structures),
                enums: enumsToRecord(this.enums)
            },
            tables: this.tables.map(({ moduleKey, fields, rows }) => ({
                moduleKey,
                path: pathForModuleKey(moduleKey, '.csv'),
                fields,
                rows
            })),
            constants: this.constants.map(({ moduleKey, description, text }) => ({
                moduleKey,
                path: pathForModuleKey(moduleKey, '.json'),
                description,
                text
            })),
            deletedPaths: this.deletedPathsForSave()
        };
    }

    private createTableRowsSaveRequest(targetTable: CsvTableState): ConfigToolSaveRequest {
        return {
            manifest: this.manifest,
            schema: {
                ...this.schema,
                structures: this.schema.structures,
                enums: this.schema.enums
            },
            tables: this.tables
                .filter((table) => table.savedModuleKey)
                .map((table) => {
                    const moduleKey = table.savedModuleKey;
                    const fields = table.savedFields.map(cloneFieldSchema);
                    return {
                        moduleKey,
                        path: pathForModuleKey(moduleKey, '.csv'),
                        fields,
                        rows: (table.id === targetTable.id ? table.rows : table.savedRows)
                            .map((row) => withFieldDefaults(row, fields))
                    };
                }),
            constants: this.constants
                .filter((constant) => constant.savedModuleKey)
                .map((constant) => ({
                    moduleKey: constant.savedModuleKey,
                    path: pathForModuleKey(constant.savedModuleKey, '.json'),
                    description: constant.savedDescription,
                    text: constant.savedText
                })),
            deletedPaths: []
        };
    }

    private async postSaveRequest(request: ConfigToolSaveRequest): Promise<ConfigToolPayload> {
        return await this.repository.save(request);
    }

    destroy(): void {
        this.container.replaceChildren();
    }

    private applySavedRowsFromPayload(table: CsvTableState, payload: ConfigToolPayload): void {
        const savedTable = payload.tables.find((item) => item.moduleKey === table.savedModuleKey);
        if (!savedTable) {
            throw new Error(`保存结果中缺少数据表：${table.savedModuleKey}`);
        }

        const fields = savedTable.fields.map(cloneFieldSchema);
        const rows = savedTable.rows.map((row) => withFieldDefaults(row, fields));
        table.path = savedTable.path;
        table.originalPath = savedTable.path;
        table.savedModuleKey = savedTable.moduleKey;
        table.fields = fields.map(cloneFieldSchema);
        table.savedFields = fields.map(cloneFieldSchema);
        table.rows = rows.map(cloneRow);
        table.savedRows = rows.map(cloneRow);
        this.writable = payload.writable;
    }

    private savedStructureForField(field: FieldSchema): StructureState | undefined {
        if (!field.structure) {
            return undefined;
        }
        const structure = this.schema.structures[field.structure];
        if (!structure) {
            return undefined;
        }
        return {
            key: field.structure,
            id: `saved-structure-${field.structure}`,
            description: structure.description,
            fields: structure.fields.map(cloneStructureFieldSchema),
            savedFields: structure.fields.map(cloneStructureFieldSchema),
            selectedFieldIndex: undefined
        };
    }

    private savedEnumForKey(enumKey: string): EnumState | undefined {
        const enumSchema = this.schema.enums[enumKey];
        if (!enumSchema) {
            return undefined;
        }
        return {
            key: enumKey,
            id: `saved-enum-${enumKey}`,
            description: enumSchema.description,
            values: enumSchema.values.map(cloneEnumValueSchema),
            savedValues: enumSchema.values.map(cloneEnumValueSchema),
            selectedValueIndex: undefined
        };
    }

    private async generateCode(): Promise<void> {
        if (!this.writable) {
            this.status = '只读模式，无法生成代码。';
            this.render();
            return;
        }
        if (!this.repository.generateCode) {
            this.status = '当前配置仓库不支持代码生成。';
            this.render();
            return;
        }
        if (this.hasUnsavedChanges()) {
            this.status = '存在未保存修改，请先保存后再生成代码。';
            this.render();
            return;
        }

        this.loading = true;
        this.status = '正在生成代码。';
        this.render();

        try {
            const result = await this.repository.generateCode();
            this.status = result.files.length > 0 ? '代码已生成：' + result.files.join(', ') : '代码已生成。';
        } catch (error) {
            this.status = '代码生成失败：' + errorMessage(error);
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private async save(successStatus = '配置已保存。', validationTarget: SaveValidationTarget = { kind: 'none' }): Promise<void> {
        if (!this.writable) {
            this.status = '只读模式，无法写入配置文件。';
            this.render();
            return;
        }

        this.applyGeneratedPaths();
        const errors = this.validate(validationTarget);
        if (errors.length > 0) {
            this.status = errors[0];
            this.render();
            return;
        }

        const selectionSnapshot = this.captureSelectionSnapshot();
        this.loading = true;
        this.status = '正在保存配置。';
        this.render();

        try {
            const payload = await this.postSaveRequest(this.createFullSaveRequest());
            this.applyPayload(payload);
            this.restoreSelectionSnapshot(selectionSnapshot);
            this.status = successStatus;
        } catch (error) {
            this.status = `保存失败：${errorMessage(error)}`;
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private validate(target: SaveValidationTarget): string[] {
        const errors: string[] = [];
        if (target.kind === 'table') {
            this.validateModuleIdentity(target.table, '.csv', errors);
            this.validateFields(target.table, errors);
            return errors;
        }
        if (target.kind === 'constant') {
            this.validateModuleIdentity(target.constant, '.json', errors);
            try {
                JSON.parse(target.constant.text);
            } catch (error) {
                errors.push(`${target.constant.moduleKey} JSON 错误：${errorMessage(error)}`);
            }
            return errors;
        }
        if (target.kind === 'structure') {
            this.validateStructure(target.structure, errors);
            return errors;
        }
        if (target.kind === 'enum') {
            this.validateEnum(target.enumSchema, errors);
        }
        return errors;
    }

    private validateModuleIdentity(
        item: CsvTableState | ConstantState,
        extension: '.csv' | '.json',
        errors: string[]
    ): void {
        const moduleKey = item.moduleKey;
        const configPath = pathForModuleKey(moduleKey, extension);
        if (!MODULE_KEY_PATTERN.test(moduleKey)) {
            errors.push(`模块 key 无效：${moduleKey}`);
        }
        if (!isValidConfigPath(configPath, extension)) {
            errors.push(`生成路径无效：${configPath}`);
        }

        const duplicateModuleKey = this.tables.some((table) => table.id !== item.id && table.moduleKey === moduleKey)
            || this.constants.some((constant) => constant.id !== item.id && constant.moduleKey === moduleKey);
        if (duplicateModuleKey) {
            errors.push(`模块 key 重复：${moduleKey}`);
        }

        const duplicatePath = this.tables.some((table) => table.id !== item.id && pathForModuleKey(table.moduleKey, '.csv') === configPath)
            || this.constants.some((constant) => constant.id !== item.id && pathForModuleKey(constant.moduleKey, '.json') === configPath);
        if (duplicatePath) {
            errors.push(`生成路径重复：${configPath}`);
        }
    }

    private validateEnum(enumSchema: EnumState, errors: string[]): void {
        if (!STRUCTURE_KEY_PATTERN.test(enumSchema.key)) {
            errors.push(`枚举 key 无效：${enumSchema.key}`);
        }
        if (this.enums.some((item) => item.id !== enumSchema.id && item.key === enumSchema.key)) {
            errors.push(`枚举 key 重复：${enumSchema.key}`);
        }

        const valueKeys = new Set<string>();
        const values = new Set<number>();
        enumSchema.values.forEach((enumValue) => {
            if (!/^[A-Za-z0-9_]+$/.test(enumValue.key)) {
                errors.push(`${enumSchema.key} 枚举值 key 无效：${enumValue.key}`);
            }
            if (!Number.isFinite(enumValue.value)) {
                errors.push(`${enumSchema.key}.${enumValue.key} 必须是有效数字。`);
            }
            if (valueKeys.has(enumValue.key)) {
                errors.push(`${enumSchema.key} 枚举值 key 重复：${enumValue.key}`);
            }
            if (values.has(enumValue.value)) {
                errors.push(`${enumSchema.key} 枚举值 value 重复：${enumValue.value}`);
            }
            valueKeys.add(enumValue.key);
            values.add(enumValue.value);
        });
    }

    private validateStructure(structure: StructureState, errors: string[]): void {
        if (!STRUCTURE_KEY_PATTERN.test(structure.key)) {
            errors.push(`结构 key 无效：${structure.key}`);
        }
        if (this.structures.some((item) => item.id !== structure.id && item.key === structure.key)) {
            errors.push(`结构 key 重复：${structure.key}`);
        }

        const fieldKeys = new Set<string>();
        structure.fields.forEach((field) => {
            if (!/^[A-Za-z0-9_]+$/.test(field.key)) {
                errors.push(`${structure.key} 结构字段 key 无效：${field.key}`);
            }
            if (fieldKeys.has(field.key)) {
                errors.push(`${structure.key} 结构字段 key 重复：${field.key}`);
            }
            this.validateNumberConstraintDefinition(field, `${structure.key}.${field.key}`, errors);
            fieldKeys.add(field.key);
        });
    }

    private validateFields(table: CsvTableState, errors: string[]): void {
        if (table.fields.length === 0) {
            errors.push(`${table.moduleKey} 至少需要一个字段。`);
            return;
        }
        const keys = new Set<string>();
        table.fields.forEach((field) => {
            if (!/^[A-Za-z0-9_]+$/.test(field.key)) {
                errors.push(`${table.moduleKey} 字段 key 无效：${field.key}`);
            }
            if (keys.has(field.key)) {
                errors.push(`${table.moduleKey} 字段 key 重复：${field.key}`);
            }
            if (!isStructuredField(field) && field.structure) {
                errors.push(`${table.moduleKey}.${field.key} 只有 json/json[] 字段可以引用结构。`);
            }
            if (field.key === 'id' && field.type !== 'number') {
                errors.push(`${table.moduleKey}.id 必须是 number 类型。`);
            }
            if (field.key === 'name' && field.type !== 'string') {
                errors.push(`${table.moduleKey}.name 必须是 string 类型。`);
            }
            this.validateNumberConstraintDefinition(field, `${table.moduleKey}.${field.key}`, errors);
            keys.add(field.key);
        });
        REQUIRED_CSV_FIELDS.forEach((fieldKey) => {
            if (!keys.has(fieldKey)) {
                errors.push(`${table.moduleKey} 缺少必需字段：${fieldKey}`);
            }
        });
    }

    private validateNumberConstraintDefinition(
        field: FieldSchema | StructureFieldSchema,
        label: string,
        errors: string[]
    ): void {
        const constraint = normalizedNumberConstraint(field.type, field.numberConstraint);
        if (!constraint) {
            return;
        }
        if (constraint.kind === 'number') {
            if (constraint.min !== undefined && constraint.max !== undefined && constraint.min > constraint.max) {
                errors.push(`${label} 数字约束的最小值不能大于最大值。`);
            }
            return;
        }
        if (constraint.kind === 'reference') {
            if (!constraint.table) {
                errors.push(`${label} 引用约束需要选择引用表。`);
                return;
            }
            if (!this.tables.some((table) => table.moduleKey === constraint.table)) {
                errors.push(`${label} 引用了不存在的表：${constraint.table}`);
            }
            return;
        }
        if (constraint.kind === 'enum') {
            if (!constraint.enum) {
                errors.push(`${label} 枚举约束需要选择枚举类型。`);
                return;
            }
            if (!this.enums.some((enumSchema) => enumSchema.key === constraint.enum)) {
                errors.push(`${label} 引用了不存在的枚举：${constraint.enum}`);
            }
        }
    }

    private validateRows(
        table: CsvTableState,
        errors: string[],
        structureResolver = (field: FieldSchema): StructureState | undefined => this.structureForField(field),
        enumResolver = (enumKey: string): EnumState | undefined => this.enumForKey(enumKey)
    ): void {
        table.rows.forEach((row, rowIndex) => {
            table.fields.forEach((field) => {
                const error = validateCellValue(
                    row[field.key] ?? '',
                    field,
                    structureResolver(field),
                    enumResolver
                );
                if (error) {
                    errors.push(`${table.moduleKey} 第 ${rowIndex + 1} 行 ${field.key}：${error}`);
                }
            });
        });
    }

    private deletedPathsForSave(): string[] {
        const deletedPaths = new Set(this.deletedPaths);
        this.tables.forEach((table) => {
            const nextPath = pathForModuleKey(table.moduleKey, '.csv');
            if (table.originalPath && table.originalPath !== nextPath) {
                deletedPaths.add(table.originalPath);
            }
        });
        this.constants.forEach((constant) => {
            const nextPath = pathForModuleKey(constant.moduleKey, '.json');
            if (constant.originalPath && constant.originalPath !== nextPath) {
                deletedPaths.add(constant.originalPath);
            }
        });
        return Array.from(deletedPaths);
    }

    private applyGeneratedPaths(): void {
        this.tables.forEach((table) => {
            table.path = pathForModuleKey(table.moduleKey, '.csv');
        });
        this.constants.forEach((constant) => {
            constant.path = pathForModuleKey(constant.moduleKey, '.json');
        });
    }

    private captureSelectionSnapshot(): SelectionSnapshot | undefined {
        if (this.selected?.kind === 'table') {
            const table = this.tables.find((item) => item.id === this.selected?.id);
            if (!table) {
                return undefined;
            }
            return {
                kind: 'table',
                moduleKey: table.moduleKey,
                path: table.path,
                activeTab: table.activeTab,
                selectedFieldIndex: table.selectedFieldIndex,
                selectedRowIndex: table.selectedRowIndex
            };
        }

        if (this.selected?.kind === 'constant') {
            const constant = this.constants.find((item) => item.id === this.selected?.id);
            if (!constant) {
                return undefined;
            }
            return {
                kind: 'constant',
                moduleKey: constant.moduleKey,
                path: constant.path
            };
        }

        if (this.selected?.kind === 'structure') {
            const structure = this.structures.find((item) => item.id === this.selected?.id);
            if (!structure) {
                return undefined;
            }
            return {
                kind: 'structure',
                key: structure.key,
                selectedFieldIndex: structure.selectedFieldIndex
            };
        }

        if (this.selected?.kind === 'enum') {
            const enumSchema = this.enums.find((item) => item.id === this.selected?.id);
            if (!enumSchema) {
                return undefined;
            }
            return {
                kind: 'enum',
                key: enumSchema.key,
                selectedValueIndex: enumSchema.selectedValueIndex
            };
        }

        return undefined;
    }

    private restoreSelectionSnapshot(snapshot: SelectionSnapshot | undefined): void {
        if (!snapshot) {
            this.ensureSelection();
            return;
        }

        if (snapshot.kind === 'table') {
            const table = this.tables.find((item) => item.moduleKey === snapshot.moduleKey)
                ?? this.tables.find((item) => item.path === snapshot.path);
            if (table) {
                this.selected = { kind: 'table', id: table.id };
                table.activeTab = snapshot.activeTab;
                table.selectedFieldIndex = table.fields[snapshot.selectedFieldIndex ?? -1] ? snapshot.selectedFieldIndex : undefined;
                table.selectedRowIndex = table.rows[snapshot.selectedRowIndex ?? -1] ? snapshot.selectedRowIndex : undefined;
                return;
            }
        }

        if (snapshot.kind === 'constant') {
            const constant = this.constants.find((item) => item.moduleKey === snapshot.moduleKey)
                ?? this.constants.find((item) => item.path === snapshot.path);
            if (constant) {
                this.selected = { kind: 'constant', id: constant.id };
                return;
            }
        }

        if (snapshot.kind === 'structure') {
            const structure = this.structures.find((item) => item.key === snapshot.key);
            if (structure) {
                this.selected = { kind: 'structure', id: structure.id };
                structure.selectedFieldIndex = structure.fields[snapshot.selectedFieldIndex ?? -1] ? snapshot.selectedFieldIndex : undefined;
                return;
            }
        }

        if (snapshot.kind === 'enum') {
            const enumSchema = this.enums.find((item) => item.key === snapshot.key);
            if (enumSchema) {
                this.selected = { kind: 'enum', id: enumSchema.id };
                enumSchema.selectedValueIndex = enumSchema.values[snapshot.selectedValueIndex ?? -1] ? snapshot.selectedValueIndex : undefined;
                return;
            }
        }

        this.ensureSelection();
    }

    private uniqueModuleKey(base: string): string {
        const existing = new Set(this.tables.map((table) => table.moduleKey).concat(this.constants.map((constant) => constant.moduleKey)));
        if (!existing.has(base)) {
            return base;
        }

        let index = 2;
        while (existing.has(`${base}_${index}`)) {
            index += 1;
        }
        return `${base}_${index}`;
    }

    private uniqueStructureKey(base: string): string {
        const existing = new Set(this.structures.map((structure) => structure.key));
        if (!existing.has(base)) {
            return base;
        }

        let index = 2;
        while (existing.has(`${base}${index}`)) {
            index += 1;
        }
        return `${base}${index}`;
    }

    private uniqueEnumKey(base: string): string {
        const existing = new Set(this.enums.map((enumSchema) => enumSchema.key));
        if (!existing.has(base)) {
            return base;
        }

        let index = 2;
        while (existing.has(`${base}${index}`)) {
            index += 1;
        }
        return `${base}${index}`;
    }

    private itemsForKind(kind: ResourceKind): Array<CsvTableState | ConstantState | StructureState | EnumState> {
        if (kind === 'table') {
            return this.tables;
        }
        if (kind === 'constant') {
            return this.constants;
        }
        if (kind === 'structure') {
            return this.structures;
        }
        return this.enums;
    }

    private selectFirstItemInKind(kind: ResourceKind): void {
        const item = this.itemsForKind(kind)[0];
        this.selected = item ? { kind, id: item.id } : undefined;
    }

    private structureForField(field: FieldSchema): StructureState | undefined {
        if (!field.structure) {
            return undefined;
        }
        return this.structures.find((structure) => structure.key === field.structure);
    }

    private enumForKey(enumKey: string): EnumState | undefined {
        return this.enums.find((enumSchema) => enumSchema.key === enumKey);
    }

    private isEnumReferenced(enumKey: string): boolean {
        return this.tables.some((table) => table.fields.some((field) => field.numberConstraint?.kind === 'enum' && field.numberConstraint.enum === enumKey))
            || this.structures.some((structure) => structure.fields.some((field) => field.numberConstraint?.kind === 'enum' && field.numberConstraint.enum === enumKey));
    }

    private readonlyFieldTypeLabel(field: FieldSchema): string {
        if (!isStructuredField(field)) {
            return field.type;
        }

        const structure = this.structureForField(field);
        if (structure) {
            return field.type === 'json[]' ? `${structure.key}[]` : structure.key;
        }

        return field.type === 'json[]' ? 'JSON[]' : 'JSON';
    }
}

async function fetchConfigPayload(configUrl: string): Promise<ConfigToolPayload> {
    const response = await fetch(configUrl);
    if (!response.ok) {
        throw new Error(`开发保存接口不可用：${response.status}`);
    }
    return await response.json() as ConfigToolPayload;
}

async function loadStaticPayload(staticBaseUrl: string): Promise<ConfigToolPayload> {
    const manifest = await fetchJson<Manifest>(joinUrl(staticBaseUrl, 'manifest.json'));
    const schema = normalizeSchema(await fetchOptionalJson<ConfigSchema>(joinUrl(staticBaseUrl, 'schema.json'), { version: 1, tables: {}, constants: {}, structures: {}, enums: {} }));
    const tables: CsvTablePayload[] = [];
    const constants: ConstantPayload[] = [];

    for (const [moduleKey, path] of moduleEntries(manifest.modules ?? {})) {
        if (path.toLowerCase().endsWith('.csv')) {
            const text = await fetchText(joinUrl(staticBaseUrl, path));
            const { headers, rows } = csvToRows(text);
            const fields = fieldsForTable(schema, moduleKey, headers, rows);
            tables.push({
                moduleKey,
                path,
                fields,
                rows: rows.map((row) => withFieldDefaults(row, fields))
            });
            continue;
        }

        if (path.toLowerCase().endsWith('.json')) {
            const text = await fetchText(joinUrl(staticBaseUrl, path));
            JSON.parse(text);
            constants.push({
                moduleKey,
                path,
                description: schema.constants[moduleKey]?.description ?? '',
                text
            });
        }
    }

    return { writable: false, manifest, schema, tables, constants };
}

async function postConfigPayload(saveUrl: string, request: ConfigToolSaveRequest): Promise<ConfigToolPayload> {
    const response = await fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    const payload = await response.json() as ConfigToolPayload | { error?: string };
    if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : '保存失败。');
    }
    return payload as ConfigToolPayload;
}

async function postCodegenRequest(generateUrl: string, options: ConfigToolCodegenRequestOptions): Promise<ConfigToolCodegenResult> {
    const response = await fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options })
    });
    const payload = await response.json() as ConfigToolCodegenResult | { error?: string };
    if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : '代码生成失败。');
    }
    return payload as ConfigToolCodegenResult;
}

function joinUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const relativePath = path.replace(/^\/+/, '');
    return base ? `${base}/${relativePath}` : `/${relativePath}`;
}
async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`无法读取 ${url}：${response.status}`);
    }
    return await response.json() as T;
}

async function fetchOptionalJson<T>(url: string, fallback: T): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
        return fallback;
    }
    return await response.json() as T;
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`无法读取 ${url}：${response.status}`);
    }
    return await response.text();
}

function moduleEntries(modules: ConfigModuleTree, path: string[] = []): Array<[string, string]> {
    return Object.entries(modules).flatMap(([key, value]) => {
        const nextPath = path.concat(key);
        if (typeof value === 'string') {
            return [[nextPath.join('.'), value]];
        }
        return moduleEntries(value, nextPath);
    });
}

function fieldsForTable(schema: ConfigSchema, moduleKey: string, headers: string[], rows: CsvRow[]): FieldSchema[] {
    const schemaFields: FieldSchema[] = (schema.tables[moduleKey]?.fields ?? [])
        .filter((field) => field.key)
        .map((field) => {
            const type = FIELD_TYPES.includes(field.type) ? field.type : 'string';
            return {
                key: field.key,
                type,
                description: field.description ?? '',
                structure: field.structure,
                numberConstraint: normalizedNumberConstraint(type, field.numberConstraint)
            };
        });
    const knownKeys = new Set(schemaFields.map((field) => field.key));
    const inferred: FieldSchema[] = headers
        .filter((header) => header && !knownKeys.has(header))
        .map((header) => ({
            key: header,
            type: inferFieldType(header, rows.map((row) => row[header] ?? '')),
            description: ''
        }));
    return ensureRequiredFields(schemaFields.length > 0 ? schemaFields.concat(inferred) : inferred);
}

function normalizeSchema(schema: ConfigSchema): ConfigSchema {
    return {
        version: Number(schema.version ?? 1),
        tables: schema.tables ?? {},
        constants: schema.constants ?? {},
        structures: normalizeStructureRecord(schema.structures),
        enums: normalizeEnumRecord(schema.enums)
    };
}

function normalizeStructureRecord(structures: ConfigSchema['structures'] | undefined): Record<string, StructureSchema> {
    return Object.fromEntries(Object.entries(structures ?? {}).map(([key, structure]) => [
        key,
        {
            description: structure.description ?? '',
            fields: (structure.fields ?? []).map((field) => {
                const type = STRUCTURE_FIELD_TYPES.includes(field.type) ? field.type : 'string';
                return {
                    key: field.key,
                    type,
                    description: field.description ?? '',
                    numberConstraint: normalizedNumberConstraint(type, field.numberConstraint)
                };
            })
        }
    ]));
}

function structuresToRecord(structures: StructureState[]): Record<string, StructureSchema> {
    return Object.fromEntries(structures.map((structure) => [
        structure.key,
        {
            description: structure.description,
            fields: structure.fields.map(cloneStructureFieldSchema)
        }
    ]));
}

function normalizeEnumRecord(enums: ConfigSchema['enums'] | undefined): Record<string, EnumSchema> {
    return Object.fromEntries(Object.entries(enums ?? {}).map(([key, enumSchema]) => [
        key,
        {
            description: enumSchema.description ?? '',
            values: sortEnumValues((enumSchema.values ?? []).map((enumValue) => ({
                key: enumValue.key,
                value: Number(enumValue.value),
                description: enumValue.description ?? ''
            })))
        }
    ]));
}

function enumsToRecord(enums: EnumState[]): Record<string, EnumSchema> {
    return Object.fromEntries(enums.map((enumSchema) => [
        enumSchema.key,
        {
            description: enumSchema.description,
            values: sortEnumValues(enumSchema.values).map(cloneEnumValueSchema)
        }
    ]));
}

function inferFieldType(key: string, values: string[]): FieldType {
    const filledValues = values.filter((value) => value !== '');
    if (key === 'id' || key.endsWith('_id')) {
        return 'number';
    }
    if (['tags', 'positions', 'base_abilities', 'ability_slots'].includes(key)) {
        return 'number[]';
    }
    if (['nodes', 'effects'].includes(key)) {
        return 'json[]';
    }
    if (key.endsWith('_json')) {
        return 'json';
    }
    if (filledValues.length > 0 && filledValues.every((value) => Number.isFinite(Number(value)))) {
        return 'number';
    }
    if (filledValues.length > 0 && filledValues.every((value) => value === 'true' || value === 'false')) {
        return 'boolean';
    }
    return 'string';
}

function csvToRows(text: string): { headers: string[]; rows: CsvRow[] } {
    const table = parseCsv(text.trimEnd());
    const [headers, ...records] = table;
    if (!headers || (headers.length === 1 && headers[0] === '')) {
        return { headers: [], rows: [] };
    }

    return {
        headers,
        rows: records
            .filter((record) => record.some((value) => value.length > 0))
            .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])))
    };
}

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let value = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"' && quoted && next === '"') {
            value += '"';
            index += 1;
            continue;
        }

        if (char === '"') {
            quoted = !quoted;
            continue;
        }

        if (char === ',' && !quoted) {
            row.push(value);
            value = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && next === '\n') {
                index += 1;
            }
            row.push(value);
            rows.push(row);
            row = [];
            value = '';
            continue;
        }

        value += char;
    }

    row.push(value);
    rows.push(row);
    return rows;
}

function withFieldDefaults(row: CsvRow, fields: FieldSchema[]): CsvRow {
    return Object.fromEntries(fields.map((field) => [field.key, row[field.key] ?? '']));
}

function ensureRequiredFields(fields: FieldSchema[]): FieldSchema[] {
    const normalizedFields = fields.map(normalizeRequiredField);
    const keys = new Set(normalizedFields.map((field) => field.key));
    const missingFields: FieldSchema[] = [];
    if (!keys.has('id')) {
        missingFields.push({ key: 'id', type: 'number', description: requiredFieldDescription('id') });
    }
    if (!keys.has('name')) {
        missingFields.push({ key: 'name', type: 'string', description: requiredFieldDescription('name') });
    }
    return missingFields.concat(normalizedFields);
}

function isRequiredField(key: string): boolean {
    return REQUIRED_CSV_FIELDS.includes(key as typeof REQUIRED_CSV_FIELDS[number]);
}

function normalizeRequiredField(field: FieldSchema): FieldSchema {
    if (field.key === 'id') {
        return { key: field.key, type: 'number', description: requiredFieldDescription('id') };
    }
    if (field.key === 'name') {
        return { key: field.key, type: 'string', description: requiredFieldDescription('name') };
    }
    return {
        ...field,
        numberConstraint: normalizedNumberConstraint(field.type, field.numberConstraint)
    };
}

function requiredFieldDescription(key: string): string {
    if (key === 'id') {
        return 'ID';
    }
    if (key === 'name') {
        return '显示名称';
    }
    return '';
}

function rowLabel(row: CsvRow, rowIndex: number): string {
    const id = row.id?.trim() || `#${rowIndex + 1}`;
    const name = row.name?.trim() || '未命名';
    return `${id}.${name}`;
}

function navSelectClass(active: boolean, dirty: boolean): string {
    return [
        'config-row-nav__select',
        active ? 'config-row-nav__select--active' : '',
        dirty ? 'config-row-nav__select--dirty' : ''
    ].filter(Boolean).join(' ');
}

function fieldLabel(field: FieldSchema, fieldIndex: number): string {
    const key = field.key.trim();
    const index = `#${fieldIndex + 1}`;
    return key ? `${index} ${key}` : index;
}

function structureFieldLabel(field: StructureFieldSchema, fieldIndex: number): string {
    const key = field.key.trim();
    const index = `#${fieldIndex + 1}`;
    return key ? `${index} ${key}` : index;
}

function enumValueLabel(enumValue: EnumValueSchema, valueIndex: number): string {
    const key = enumValue.key.trim();
    const prefix = Number.isFinite(enumValue.value) ? String(enumValue.value) : `#${valueIndex + 1}`;
    return key ? `${prefix}.${key}` : prefix;
}

function descriptionKeyLabel(description: string | undefined, key: string | undefined, fallback: string): string {
    const labelDescription = (description ?? '').trim();
    const labelKey = (key ?? '').trim();
    if (labelDescription && labelKey) {
        return `${labelDescription}(${labelKey})`;
    }
    return labelDescription || labelKey || fallback;
}

function enumSchemaOptionLabel(enumSchema: EnumState): string {
    return descriptionKeyLabel(enumSchema.description, enumSchema.key, enumSchema.key);
}

function enumValueOptionLabel(enumValue: EnumValueSchema, fallback: string): string {
    return descriptionKeyLabel(enumValue.description, enumValue.key, fallback);
}

function referenceRowOptionLabel(row: CsvRow, id: string): string {
    const key = row.key?.trim() || id;
    const description = row.desc?.trim() || row.description?.trim() || row.name?.trim();
    return descriptionKeyLabel(description, key, id);
}

function navItemTitle(item: CsvTableState | ConstantState | StructureState | EnumState): string {
    if ('moduleKey' in item) {
        return item.moduleKey || '未命名';
    }
    return item.key || '未命名';
}

function navItemMeta(item: CsvTableState | ConstantState | StructureState | EnumState): string {
    if ('rows' in item) {
        return `CSV · ${item.rows.length} 行`;
    }
    if ('text' in item) {
        return item.description || 'JSON 常量';
    }
    if ('values' in item) {
        return item.description || '自定义 number 枚举';
    }
    return item.description || '自定义 JSON 结构';
}

function isStructuredField(field: FieldSchema): boolean {
    return field.type === 'json' || field.type === 'json[]';
}

function isArrayField(type: FieldType | StructureFieldType): boolean {
    return type.endsWith('[]');
}

function baseFieldType(type: FieldType | StructureFieldType): FieldBaseType {
    return arrayItemType(type);
}

function fieldTypeWithArray(baseType: FieldBaseType, array: boolean): FieldType {
    return (array ? `${baseType}[]` : baseType) as FieldType;
}

function structureFieldTypeWithArray(baseType: BasicType, array: boolean): StructureFieldType {
    return (array ? `${baseType}[]` : baseType) as StructureFieldType;
}

function arrayItemType(type: FieldType | StructureFieldType): BasicType | 'json' {
    if (type === 'json[]') {
        return 'json';
    }
    return type.replace('[]', '') as BasicType;
}

function normalizedNumberConstraint(
    type: FieldType | StructureFieldType,
    constraint: NumberConstraintSchema | undefined
): NumberConstraintSchema | undefined {
    return compactNumberConstraint(type, constraint);
}

function compactNumberConstraint(
    type: FieldType | StructureFieldType,
    constraint: NumberConstraintSchema | undefined
): NumberConstraintSchema | undefined {
    if (baseFieldType(type) !== 'number') {
        return undefined;
    }

    const kind = isNumberConstraintKind(constraint?.kind) ? constraint.kind : 'number';
    if (kind === 'number') {
        const min = optionalNumber(constraint?.min);
        const max = optionalNumber(constraint?.max);
        if (min === undefined && max === undefined) {
            return undefined;
        }
        return {
            kind,
            ...(min === undefined ? {} : { min }),
            ...(max === undefined ? {} : { max })
        };
    }

    if (kind === 'reference') {
        const table = (constraint?.table ?? '').trim();
        return table ? { kind, table } : { kind };
    }

    const enumKey = (constraint?.enum ?? '').trim();
    return enumKey ? { kind, enum: enumKey } : { kind };
}

function isNumberConstraintKind(value: unknown): value is NumberConstraintKind {
    return NUMBER_CONSTRAINT_KINDS.includes(value as NumberConstraintKind);
}

function optionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
}

function parseArrayValue(value: string): unknown[] {
    if (!value.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseObjectValue(value: string, structure: StructureState): Record<string, unknown> {
    if (!value.trim()) {
        return defaultStructureObject(structure);
    }
    try {
        return asObject(JSON.parse(value), structure);
    } catch {
        return defaultStructureObject(structure);
    }
}

function asObject(value: unknown, structure: StructureState): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return defaultStructureObject(structure);
    }
    return {
        ...defaultStructureObject(structure),
        ...(value as Record<string, unknown>)
    };
}

function defaultArrayItem(type: FieldType | StructureFieldType, structure?: StructureState): unknown {
    if (type === 'json[]') {
        return structure ? defaultStructureObject(structure) : {};
    }
    const itemType = arrayItemType(type);
    if (itemType === 'json') {
        return {};
    }
    return basicStringToValue(defaultCellValue(itemType), itemType);
}

function defaultStructureObject(structure: StructureState): Record<string, unknown> {
    return Object.fromEntries(structure.fields.map((field) => [
        field.key,
        isArrayField(field.type) ? [] : basicStringToValue(defaultCellValue(field.type), field.type as BasicType)
    ]));
}

function cloneFieldSchema(field: FieldSchema): FieldSchema {
    return {
        ...field,
        numberConstraint: cloneNumberConstraint(field.numberConstraint)
    };
}

function cloneStructureFieldSchema(field: StructureFieldSchema): StructureFieldSchema {
    return {
        ...field,
        numberConstraint: cloneNumberConstraint(field.numberConstraint)
    };
}

function cloneEnumValueSchema(enumValue: EnumValueSchema): EnumValueSchema {
    return { ...enumValue };
}

function cloneNumberConstraint(constraint: NumberConstraintSchema | undefined): NumberConstraintSchema | undefined {
    return constraint ? { ...constraint } : undefined;
}

function cloneRow(row: CsvRow): CsvRow {
    return { ...row };
}

function sameFieldSchema(left: FieldSchema, right: FieldSchema): boolean {
    return left.key === right.key
        && left.type === right.type
        && left.description === right.description
        && (left.structure ?? '') === (right.structure ?? '')
        && sameNumberConstraint(left.type, left.numberConstraint, right.type, right.numberConstraint);
}

function sameStructureFieldSchema(left: StructureFieldSchema, right: StructureFieldSchema): boolean {
    return left.key === right.key
        && left.type === right.type
        && left.description === right.description
        && sameNumberConstraint(left.type, left.numberConstraint, right.type, right.numberConstraint);
}

function sameEnumValueSchema(left: EnumValueSchema, right: EnumValueSchema): boolean {
    return left.key === right.key
        && left.value === right.value
        && left.description === right.description;
}

function sameNumberConstraint(
    leftType: FieldType | StructureFieldType,
    left: NumberConstraintSchema | undefined,
    rightType: FieldType | StructureFieldType,
    right: NumberConstraintSchema | undefined
): boolean {
    const leftConstraint = normalizedNumberConstraint(leftType, left);
    const rightConstraint = normalizedNumberConstraint(rightType, right);
    return (leftConstraint?.kind ?? 'number') === (rightConstraint?.kind ?? 'number')
        && (leftConstraint?.min ?? '') === (rightConstraint?.min ?? '')
        && (leftConstraint?.max ?? '') === (rightConstraint?.max ?? '')
        && (leftConstraint?.table ?? '') === (rightConstraint?.table ?? '')
        && (leftConstraint?.enum ?? '') === (rightConstraint?.enum ?? '');
}

function arrayFromUnknown(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function valueToBasicString(value: unknown, type: BasicType): string {
    if (type === 'boolean') {
        return value === true || value === 'true' ? 'true' : 'false';
    }
    if (type === 'number') {
        return value === undefined || value === null || value === '' ? '' : String(value);
    }
    return value === undefined || value === null ? '' : String(value);
}

function basicStringToValue(value: string, type: BasicType): string | number | boolean {
    if (type === 'boolean') {
        return value === 'true';
    }
    if (type === 'number') {
        return value === '' ? 0 : Number(value);
    }
    return value;
}

function validateNumberConstraintValue(
    value: number,
    field: FieldSchema | StructureFieldSchema,
    enumResolver?: EnumResolver
): string | undefined {
    const constraint = normalizedNumberConstraint(field.type, field.numberConstraint);
    if (!constraint) {
        return undefined;
    }
    if (constraint.kind === 'number') {
        if (constraint.min !== undefined && value < constraint.min) {
            return `必须大于等于 ${constraint.min}。`;
        }
        if (constraint.max !== undefined && value > constraint.max) {
            return `必须小于等于 ${constraint.max}。`;
        }
        return undefined;
    }
    if (constraint.kind === 'enum' && constraint.enum && enumResolver) {
        const enumSchema = enumResolver(constraint.enum);
        if (enumSchema && !enumSchema.values.some((enumValue) => enumValue.value === value)) {
            return `必须是 ${constraint.enum} 的枚举值。`;
        }
    }
    return undefined;
}

function validateCellValue(value: string, field: FieldSchema, structure?: StructureState, enumResolver?: EnumResolver): string | undefined {
    if (value === '') {
        return undefined;
    }

    if (field.type === 'number') {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) {
            return '必须是数字。';
        }
        return validateNumberConstraintValue(numberValue, field, enumResolver);
    }

    if (field.type === 'boolean' && value !== 'true' && value !== 'false') {
        return '必须是 true 或 false。';
    }

    if (field.type === 'json') {
        const parsed = parseJsonValue(value);
        if (parsed === undefined) {
            return parseJsonError(value);
        }
        if (structure) {
            return validateStructureValue(parsed, structure, enumResolver);
        }
        return undefined;
    }

    if (field.type === 'number[]') {
        const parsed = parseJsonValue(value);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'number' && Number.isFinite(item))) {
            return '必须是数字数组 JSON。';
        }
        const invalidItem = parsed.find((item) => validateNumberConstraintValue(item as number, field, enumResolver));
        if (invalidItem !== undefined) {
            return validateNumberConstraintValue(invalidItem as number, field, enumResolver);
        }
    }

    if (field.type === 'string[]') {
        const parsed = parseJsonValue(value);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
            return '必须是字符串数组 JSON。';
        }
    }

    if (field.type === 'boolean[]') {
        const parsed = parseJsonValue(value);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'boolean')) {
            return '必须是布尔数组 JSON。';
        }
    }

    if (field.type === 'json[]') {
        const parsed = parseJsonValue(value);
        if (!Array.isArray(parsed)) {
            return '必须是 JSON 数组。';
        }
        if (structure) {
            const invalidItem = parsed.find((item) => validateStructureValue(item, structure, enumResolver));
            if (invalidItem !== undefined) {
                return validateStructureValue(invalidItem, structure, enumResolver);
            }
        }
    }

    return undefined;
}

function validateStructureValue(value: unknown, structure: StructureState, enumResolver?: EnumResolver): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return `必须是 ${structure.key} 对象。`;
    }

    const objectValue = value as Record<string, unknown>;
    for (const field of structure.fields) {
        const fieldValue = objectValue[field.key];
        if (isArrayField(field.type)) {
            const arrayValue = Array.isArray(fieldValue) ? fieldValue : undefined;
            if (!arrayValue) {
                return `${field.key} 必须是数组。`;
            }
            const itemType = arrayItemType(field.type);
            if (itemType === 'number' && !arrayValue.every((item) => typeof item === 'number' && Number.isFinite(item))) {
                return `${field.key} 必须是数字数组。`;
            }
            if (itemType === 'number') {
                const invalidItem = arrayValue.find((item) => validateNumberConstraintValue(item as number, field, enumResolver));
                if (invalidItem !== undefined) {
                    return `${field.key} ${validateNumberConstraintValue(invalidItem as number, field, enumResolver)}`;
                }
            }
            if (itemType === 'string' && !arrayValue.every((item) => typeof item === 'string')) {
                return `${field.key} 必须是字符串数组。`;
            }
            if (itemType === 'boolean' && !arrayValue.every((item) => typeof item === 'boolean')) {
                return `${field.key} 必须是布尔数组。`;
            }
            continue;
        }
        if (field.type === 'number') {
            if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
                return `${field.key} 必须是数字。`;
            }
            const numberError = validateNumberConstraintValue(fieldValue, field, enumResolver);
            if (numberError) {
                return `${field.key} ${numberError}`;
            }
        }
        if (field.type === 'string' && typeof fieldValue !== 'string') {
            return `${field.key} 必须是字符串。`;
        }
        if (field.type === 'boolean' && typeof fieldValue !== 'boolean') {
            return `${field.key} 必须是布尔值。`;
        }
    }

    return undefined;
}

function parseJsonError(value: string): string | undefined {
    try {
        JSON.parse(value);
        return undefined;
    } catch (error) {
        return errorMessage(error);
    }
}

function parseJsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function defaultCellValue(type: FieldType | StructureFieldType | BasicType | 'json'): string {
    if (type === 'boolean') {
        return 'false';
    }
    if (type === 'number[]' || type === 'string[]' || type === 'boolean[]' || type === 'json[]') {
        return '[]';
    }
    if (type === 'json') {
        return '';
    }
    return '';
}

function uniqueFieldKey(fields: FieldSchema[], base: string): string {
    const keys = new Set(fields.map((field) => field.key));
    if (!keys.has(base)) {
        return base;
    }

    let index = 2;
    while (keys.has(`${base}_${index}`)) {
        index += 1;
    }
    return `${base}_${index}`;
}

function uniqueStructureFieldKey(fields: StructureFieldSchema[], base: string): string {
    const keys = new Set(fields.map((field) => field.key));
    if (!keys.has(base)) {
        return base;
    }

    let index = 2;
    while (keys.has(`${base}_${index}`)) {
        index += 1;
    }
    return `${base}_${index}`;
}

function uniqueEnumValueKey(values: EnumValueSchema[], base: string): string {
    const keys = new Set(values.map((enumValue) => enumValue.key));
    if (!keys.has(base)) {
        return base;
    }

    let index = 2;
    while (keys.has(`${base}_${index}`)) {
        index += 1;
    }
    return `${base}_${index}`;
}

function nextEnumValue(values: EnumValueSchema[]): number {
    const usedValues = new Set(values.map((enumValue) => enumValue.value));
    let value = 1;
    while (usedValues.has(value)) {
        value += 1;
    }
    return value;
}

function sortEnumValues(values: EnumValueSchema[]): EnumValueSchema[] {
    return values.slice().sort((left, right) => {
        const valueDelta = left.value - right.value;
        if (valueDelta !== 0) {
            return valueDelta;
        }
        return left.key.localeCompare(right.key);
    });
}

function swapItems<T>(items: T[], leftIndex: number, rightIndex: number): void {
    [items[leftIndex], items[rightIndex]] = [items[rightIndex], items[leftIndex]];
}

function remapMovedSelection(selectionIndex: number | undefined, sourceIndex: number, targetIndex: number): number | undefined {
    if (selectionIndex === undefined) {
        return undefined;
    }
    if (selectionIndex === sourceIndex) {
        return targetIndex;
    }
    if (selectionIndex === targetIndex) {
        return sourceIndex;
    }
    return selectionIndex;
}

function defaultPathForModule(moduleKey: string, extension: '.csv' | '.json'): string {
    const parts = moduleKey.split('.');
    const fileName = `${parts[parts.length - 1]}${extension}`;
    if (parts.length === 1) {
        return fileName;
    }
    return `${parts.slice(0, -1).join('/')}/${fileName}`;
}

function pathForModuleKey(moduleKey: string, extension: '.csv' | '.json'): string {
    const normalized = moduleKey.trim();
    return normalized ? defaultPathForModule(normalized, extension) : '';
}

function isValidConfigPath(value: string, extension: '.csv' | '.json'): boolean {
    const normalized = value.trim().replace(/\\/g, '/');
    return Boolean(normalized)
        && normalized.endsWith(extension)
        && !normalized.startsWith('/')
        && !normalized.includes('://')
        && !normalized.split('/').includes('..')
        && normalized.split('/').every((part) => part.length > 0);
}

function createId(prefix: string, source: string): string {
    nextGeneratedId += 1;
    return `${prefix}:${source}:${nextGeneratedId}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const node = element('button', className, text) as HTMLButtonElement;
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function link(text: string, href: string): HTMLAnchorElement {
    const node = element('a', 'route-link', text);
    node.href = href;
    return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className = '',
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tagName);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}
