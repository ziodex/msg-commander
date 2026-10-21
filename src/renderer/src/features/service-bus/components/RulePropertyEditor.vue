<script setup lang="ts">
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { rulePropertyTypes, type RuleProperty } from '@shared/rules'
const props = defineProps<{ label: string; correlation?: boolean }>()
const values = defineModel<RuleProperty[]>({ required: true })
</script>
<template>
	<div class="rule-property-group">
		<div class="explorer-heading">
			<h4>{{ label }}</h4>
			<Button
				type="button"
				variant="outline"
				size="sm"
				:disabled="values.length >= 32"
				@click="values.push({ name: '', type: 'string', value: '' })"
				>Add {{ label.toLowerCase() }}</Button
			>
		</div>
		<div v-for="(property, index) in values" :key="index" class="property-editor">
			<Input
				v-model="property.name"
				:aria-label="`${label} name ${index + 1}`"
				placeholder="Name"
				maxlength="128"
			/>
			<select
				v-model="property.type"
				class="commander-select"
				:aria-label="`${label} type ${index + 1}`"
			>
				<option
					v-for="type in rulePropertyTypes.filter(
						(t) => props.correlation || !['datetime', 'timespan'].includes(t),
					)"
					:key="type"
				>
					{{ type }}
				</option>
			</select>
			<Input
				v-model="property.value"
				:aria-label="`${label} value ${index + 1}`"
				placeholder="Value"
				maxlength="4096"
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				:aria-label="`Remove ${label.toLowerCase()} ${index + 1}`"
				@click="values.splice(index, 1)"
				>Remove</Button
			>
		</div>
		<p class="explorer-note">
			Names are case-sensitive. Enter numbers as invariant text and booleans as true/false.{{
				correlation
					? ' Dates need an explicit timezone; timespans use [days.]hh:mm:ss.'
					: ' Parameter names should match the SQL expression, including @ when used.'
			}}
		</p>
	</div>
</template>
