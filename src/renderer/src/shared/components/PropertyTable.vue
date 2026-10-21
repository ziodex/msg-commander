<script setup lang="ts">
import type { Property } from '@shared/service-bus'
defineProps<{ properties: Property[] }>()
</script>
<template>
	<div class="property-table-wrap">
		<table class="property-table">
			<thead>
				<tr>
					<th>Property</th>
					<th>Type</th>
					<th>Value</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="property in properties" :key="property.name">
					<th>{{ property.name }}</th>
					<td class="property-type">{{ property.type }}</td>
					<td>{{ property.value }}</td>
				</tr>
			</tbody>
		</table>
		<p v-if="!properties.length" class="explorer-note">No properties.</p>
	</div>
</template>
