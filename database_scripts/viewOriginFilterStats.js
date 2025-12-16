/**
 * View origin filtering statistics
 * 
 * Shows what origins have been filtered and validation performance
 */

import { getStats } from '../utils/originValidator.js';

console.log('📊 Origin Filter Statistics\n');
console.log('='.repeat(100));

const stats = getStats();

console.log('Overall Statistics:');
console.log(`  Total validation checks: ${stats.totalChecks.toLocaleString()}`);
console.log(`  Origins filtered: ${stats.filteredCount.toLocaleString()}`);
console.log(`  Filter rate: ${stats.filterRate}`);
console.log(`  Errors encountered: ${stats.errorCount}`);
console.log(`  Uptime: ${(stats.uptime / 1000 / 60).toFixed(1)} minutes`);

if (Object.keys(stats.filteredOrigins).length > 0) {
  console.log('\n🔒 Filtered Origins (Total Requests):');
  console.log('-'.repeat(100));
  
  // Sort by count (descending)
  const sortedOrigins = Object.entries(stats.filteredOrigins)
    .sort((a, b) => b[1] - a[1]);
  
  const totalFilteredRequests = sortedOrigins.reduce((sum, [_, count]) => sum + count, 0);
  
  console.log('Origin'.padEnd(60) + 'Requests'.padEnd(20) + '% of Filtered');
  console.log('-'.repeat(100));
  
  sortedOrigins.forEach(([origin, count]) => {
    const percentage = ((count / totalFilteredRequests) * 100).toFixed(2);
    console.log(
      origin.substring(0, 59).padEnd(60) + 
      count.toLocaleString().padEnd(20) + 
      `${percentage}%`
    );
  });
  
  console.log('-'.repeat(100));
  console.log(`Total filtered requests: ${totalFilteredRequests.toLocaleString()}`);
} else {
  console.log('\n✅ No origins have been filtered yet');
}

console.log('\n' + '='.repeat(100));
